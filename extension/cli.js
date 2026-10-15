// The panel holds no state of its own: every action and every answer goes
// through the omdrop command, the same one a terminal uses.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');

const PIPES = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
const decoder = new TextDecoder();

// The command beside this extension in its checkout, which is where `omdrop
// setup` links the extension from; else the one setup put on PATH.
export function findCli(extensionPath) {
    let dir = extensionPath;
    try {
        const target = GLib.file_read_link(extensionPath);
        dir = GLib.path_is_absolute(target)
            ? target
            : GLib.build_filenamev([GLib.path_get_dirname(extensionPath), target]);
    } catch {
        // Not a link: the extension sits in its checkout already.
    }
    const beside = GLib.canonicalize_filename(GLib.build_filenamev([dir, '..', 'bin', 'omdrop']), null);
    if (GLib.file_test(beside, GLib.FileTest.IS_EXECUTABLE))
        return beside;
    const onPath = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'omdrop']);
    if (GLib.file_test(onPath, GLib.FileTest.IS_EXECUTABLE))
        return onPath;
    return GLib.find_program_in_path('omdrop') ?? beside;
}

export class Cli {
    constructor(path) {
        this.path = path;
        this._running = new Set();
    }

    // Run to the end: {ok, status, stdout, stderr}. A command that cannot be
    // started at all answers like one that failed, with the reason as stderr.
    async run(args) {
        let proc;
        try {
            proc = Gio.Subprocess.new([this.path, ...args], PIPES);
        } catch (e) {
            return {ok: false, status: -1, stdout: '', stderr: e.message};
        }
        this._running.add(proc);
        try {
            const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
            return {ok: proc.get_successful(), status: proc.get_exit_status(), stdout: stdout ?? '', stderr: stderr ?? ''};
        } catch (e) {
            return {ok: false, status: -1, stdout: '', stderr: e.message};
        } finally {
            this._running.delete(proc);
        }
    }

    // Run with each line handed over as it arrives. Returns {proc, done}, where
    // done resolves to the exit status once both pipes have closed.
    stream(args, {onStdout = null, onStderr = null} = {}) {
        let proc;
        try {
            proc = Gio.Subprocess.new([this.path, ...args], PIPES);
        } catch (e) {
            onStderr?.(e.message);
            return {proc: null, done: Promise.resolve(-1)};
        }
        this._running.add(proc);
        const lines = async (pipe, handler) => {
            const input = new Gio.DataInputStream({base_stream: pipe, close_base_stream: true});
            try {
                for (;;) {
                    // GNOME Shell promisifies read_line_async itself, with the
                    // finish that returns bytes, so a line can arrive either way.
                    const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
                    if (line === null)
                        break;
                    handler?.(typeof line === 'string' ? line : decoder.decode(line));
                }
            } catch {
                // The pipe went away with the process.
            }
        };
        const done = Promise.all([lines(proc.get_stdout_pipe(), onStdout), lines(proc.get_stderr_pipe(), onStderr)])
            .then(() => proc.wait_async(null))
            .then(() => (proc.get_if_exited() ? proc.get_exit_status() : -1))
            .catch(() => -1)
            .finally(() => this._running.delete(proc));
        return {proc, done};
    }

    // The command stops its own sender and Bluetooth advert on TERM, so this
    // is how a lookup or a send is cancelled.
    static stop(proc) {
        try {
            proc?.send_signal(15);
        } catch {
            // Already gone.
        }
    }

    destroy() {
        for (const proc of this._running)
            Cli.stop(proc);
        this._running.clear();
    }
}
