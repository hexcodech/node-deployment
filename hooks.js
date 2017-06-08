const http = require("http");
const path = require("path");
const exec = require("child_process").exec;

const async = require("async");

const tmp = require("tmp");
const ncp = require("ncp").ncp;
const rmdir = require("rimraf");
const mkdirp = require("mkdirp");

const fetch = require("node-fetch");

const createGitHandler = require("github-webhook-handler");
const createTravisHandler = require("travisci-webhook-handler");

const config = require("./config.json");

let gitHandler, travisHandler;
setupHandlers()
	.then(() => {
		console.log(
			"Handlers are set up, loading the http server on port " + config.PORT
		);

		http
			.createServer((request, response) => {
				async.each(
					[gitHandler, travisHandler],
					(handler, callback) => {
						handler(request, response, callback);
					},
					err => {
						if (err) {
							console.log("Error: " + err);
							res.statusCode = 404;
							return res.end("-.-");
						}

						res.statusCode = 200;
						res.end("Webhook triggered!");
					}
				);
			})
			.listen(config.PORT, "0.0.0.0", () => {
				console.log("Server is running!");
			});
	})
	.catch(err => {
		console.log(err);
	});

async function setupHandlers() {
	const travisPublicKey = await fetch("https://api.travis-ci.org/config")
		.then(res => {
			return res.json();
		})
		.then(json => {
			return json.config.notifications.webhook.public_key;
		})
		.catch(err => {
			console.log(err);
		});

	console.log("travis-ci.org public key: " + travisPublicKey);

	gitHandler = createGitHandler({
		path: "/webhook/github",
		secret: config.GITHUB_SECRET
	});
	travisHandler = createTravisHandler({
		path: "/webhook/travis",
		public_key: travisPublicKey
	});

	gitHandler.on("error", err => {
		console.error("Error:", err.message);
	});
	travisHandler.on("error", err => {
		console.error("Error:", err.message);
	});

	gitHandler.on("push", event => {
		const { payload } = event;

		console.log(
			"Received a push event for %s to %s",
			payload.repository.full_name,
			payload.ref
		);

		console.log("Commits: " + payload.commits.length);

		//Check whether it is an automated build
		if (payload.commits.length === 1) {
			console.log("Message: " + payload.commits[0].message);
			if (
				payload.commits[0].message === config.GITHUB_AUTOMATED_BUILD_MESSAGE
			) {
				if (payload.repository.full_name in config.PROJECTS.github) {
					handleProject(
						payload.repository.full_name,
						payload.repository.name,
						config.PROJECTS.github[payload.repository.full_name]
					);
				}
			}
		}
	});

	travisHandler.on("success", event => {
		const { payload } = event,
			full_name = payload.repository.owner_name + "/" + payload.repository.name;

		console.log(
			"Build %s success for %s branch %s",
			payload.number,
			full_name,
			payload.branch
		);

		if (full_name in config.PROJECTS.travis) {
			handleProject(
				full_name,
				payload.repository.name,
				config.PROJECTS.travis[full_name]
			);
		}
	});
}

function handleProject(projectName, shortName, project) {
	let tmpDir = tmp.dirSync();

	console.log(
		"Cloning " +
			"git@github.com:" +
			projectName +
			".git (" +
			project.branch +
			") to " +
			tmpDir.name
	);

	//no need to escape, variables are safe, no user input
	exec(
		"cd " +
			tmpDir.name +
			" && git clone -b " +
			project.branch +
			" --single-branch https://github.com/" +
			projectName +
			".git",
		(err, stdout, stderr) => {
			if (err) {
				cleanUp([tmpDir]);

				return console.log(err);
			}

			console.log(stdout);
			console.log(stderr);

			//Delete files
			exec(
				"find " +
					project.path +
					" " +
					project.persistent
						.map(name => {
							return "-not -name '" + name + "' -type f ";
						})
						.join(" ") +
					" -delete",
				(err, stdout, stderr) => {
					if (err) {
						cleanUp([tmpDir]);
						return console.log(err);
					}
					console.log(stdout, stderr);

					if (project.type === "git-folder") {
						let folder = path.dirname(
							path.resolve(project.path, project.repo_path)
						);

						console.log(
							"Copying " +
								path.resolve(tmpDir.name, shortName, project.repo_path) +
								" to " +
								path.resolve(project.path, project.repo_path)
						);

						ncp(
							path.resolve(tmpDir.name, shortName, project.repo_path),
							path.resolve(project.path),
							err => {
								if (err) {
									cleanUp([tmpDir]);

									return console.log(err);
								}

								cleanUp([tmpDir]);
							}
						);
					} else if (project.type === "docker-compose") {
						async.each(
							[...project.compose_files, ...project.other_files],
							(name, callback) => {
								console.log("Copying " + name + " to " + project.path);
								ncp(
									path.resolve(tmpDir.name, shortName, name),
									path.resolve(project.path, name),
									callback
								);
							},
							err => {
								if (err) {
									cleanUp([tmpDir]);
									return console.log(err);
								}

								cleanUp([tmpDir]);
								//we're done here, docker is run by root now
							}
						);
					}
				}
			);
		}
	);
}

function cleanUp(tmpFolders) {
	async.each(
		tmpFolders,
		(tmpFolder, callback) => {
			rmdir(tmpFolder.name, callback);
		},
		err => {
			console.log(err);
		}
	);
}
