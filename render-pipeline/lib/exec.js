// Runs ffmpeg/ffprobe as a real child process with an argument array (never a shell string) —
// every value that ends up in these args can originate from a caption word, a script keyword, or
// a project title, so string-interpolating them into a shell command would be a command
// injection hole. execFile with an args array never invokes a shell, so this is safe regardless
// of what's inside those strings.
const { execFile } = require('child_process');

function run(bin, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

module.exports = { run };
