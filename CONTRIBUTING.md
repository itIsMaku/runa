# Contributing

Thanks for helping improve runa. Report bugs and suggest features in [GitHub issues](https://github.com/itIsMaku/runa/issues). Include your operating system, Node.js version, the command you ran, expected behavior, and actual output. A minimal project file that reproduces a detection problem is especially helpful.

## Local development

Requires Node.js 20+ and npm. There are no runtime dependencies or build steps.

```sh
git clone https://github.com/itIsMaku/runa.git
cd runa
node bin/runa.js --help
npm run check
npm test
npm pack --dry-run
```

Use `node bin/runa.js -C /path/to/project --dry-run` to try detection against another project without running its tasks.

## Pull requests

Fork the repository and make your changes on a branch. Describe the problem, the resulting behavior, and how you verified it in the pull request.

For changes to detection or process execution, add a focused test using a temporary project. Discovery must read project files without executing project code. Keep macOS, Linux, and Windows behavior in mind, especially argument passing, paths with spaces, and exit codes. Update the README when adding support for a project type or changing CLI behavior.

CI checks syntax, tests, and package contents on all three operating systems. Contributions are made under the repository's [MIT license](LICENSE).
