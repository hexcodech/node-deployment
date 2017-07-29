const path = require("path");
const exec = require("child_process").exec;

const chokidar = require("chokidar");
const debounce = require("debounce");

const config = require("./config.json");

const projects = Object.assign(
	{},
	config.PROJECTS.github,
	config.PROJECTS.travis
);

const projectNames = Object.keys(projects).filter(projectName => {
	return projects[projectName].type === "docker-compose";
});

const watching = projectNames.map(name => {
	return path.resolve(projects[name].path);
});

watching.forEach(path => {
	console.log("Watching " + path);
});

const watcher = chokidar.watch(watching, {
	ignored: /(^|[\/\\])\../,
	persistent: true
});

const onFileChange = (path, stats) => {
	const project =
		projects[
			projectNames.filter(name => {
				return path.startsWith(projects[name].path);
			})[0]
		];

	const dockerBase =
		"cd " +
		project.path +
		" && docker-compose" +
		project.compose_files.reduce((a, b) => {
			return a + " -f " + b;
		}, "");

	exec(dockerBase + " pull", (err, stdout, stderr) => {
		if (err) {
			return console.log(err);
		}

		exec(
			dockerBase + " up -d " + project.service_name,
			(err, stdout, stderr) => {
				if (err) {
					return console.log(err);
				}

				console.log(stdout);
				console.log(stderr);
			}
		);
	});
};

const debouncedOnFileChange = debounce(onFileChange, 1000 * 10);

watcher.on("change", (path, stats) => {
	console.log(path + "changed, debouncing for 10s..");
	debouncedOnFileChange(path, stats);
});
