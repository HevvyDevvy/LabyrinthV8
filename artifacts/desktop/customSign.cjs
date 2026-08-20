// Custom Windows signing hook for electron-builder.
//
// Why this exists: electron-builder's bundled signtool.exe (from its winCodeSign
// cache package) is too old to sign .appx packages — it fails with
// "SignTool Error: A required function is not present." The system-installed
// signtool.exe from the Windows SDK on GitHub's windows-latest runners handles
// .appx fine, so this hook redirects signing to that binary instead.
//
// We don't hand-build the signtool command ourselves (that's how the earlier
// "No file digest algorithm specified" error crept in — it's easy to forget a
// flag). Instead we reuse electron-builder's own configuration.computeSignToolArgs(),
// which assembles the exact same correct arguments (/fd, /td, /tr, /f, /p, /d, /du)
// it would have passed to its own bundled signtool. We only swap which binary
// actually executes them.

const { execFile } = require("node:child_process");

module.exports.default = async function customSign(configuration) {
  const signtool = process.env.SIGNTOOL_PATH;
  if (!signtool) {
    throw new Error(
      'SIGNTOOL_PATH is not set. The "Locate real signtool.exe" workflow step must run ' +
        "before the build step on windows-latest, and must write to $GITHUB_ENV."
    );
  }

  // true = we're always running this on a Windows runner (windows-latest).
  const args = configuration.computeSignToolArgs(true);

  await new Promise((resolve, reject) => {
    execFile(signtool, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};
