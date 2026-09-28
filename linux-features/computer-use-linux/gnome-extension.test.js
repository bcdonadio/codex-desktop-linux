import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const extensionPath = new URL('../../computer-use-linux/gnome-shell-extension/extension.js', import.meta.url);

async function loadHandler(options = {}) {
  const source = await readFile(extensionPath, 'utf8');
  const events = [];
  let screenshotCallback;
  let timeoutCallback;
  let stream;
  let streamNamespace;
  let rawFd = 41;
  let replies = 0;
  const invocation = {
    get_message() {
      return {
        get_unix_fd_list() {
          return options.fdList === null ? null : {
            get_length: () => options.fdLength ?? 1,
            get(index) {
              events.push(`get:${index}`);
              if (options.getThrows)
                throw new Error('fd lookup failed');
              return rawFd;
            },
          };
        },
      };
    },
    return_value(variant) {
      replies += 1;
      events.push('reply');
      this.result = variant.values;
    },
  };
  class OutputStream {
    static new(fd, closeFd) {
      events.push(`stream:${fd}:${closeFd}`);
      if (options.streamThrows)
        throw new Error('stream construction failed');
      stream = {
        flush() {
          events.push('flush');
          if (options.flushThrows)
            throw new Error('flush failed');
        },
        close() {
          events.push('close');
          if (options.closeThrows)
            throw new Error('close failed');
        },
      };
      return stream;
    }
  }
  class LegacyOutputStream extends OutputStream {
    static new(fd, closeFd) {
      streamNamespace = 'Gio.UnixOutputStream';
      return super.new(fd, closeFd);
    }
  }
  class GioUnixOutputStream extends OutputStream {
    static new(fd, closeFd) {
      streamNamespace = 'GioUnix.OutputStream';
      return super.new(fd, closeFd);
    }
  }
  const giNamespace = options.gioUnixThrows
    ? Object.defineProperty({}, 'GioUnix', { get() { throw new Error('namespace missing'); } })
    : options.gioUnixAbsent
      ? {}
      : { GioUnix: { OutputStream: GioUnixOutputStream } };
  const context = {
    Gio: { DBus: { session: {} }, UnixOutputStream: LegacyOutputStream },
    GioUnix: options.gioUnixAbsent ? undefined : { OutputStream: GioUnixOutputStream },
    imports: { gi: giNamespace },
    GLib: {
      Variant: class Variant {
        constructor(signature, values) {
          this.signature = signature;
          this.values = values;
        }
      },
      close(fd) {
        events.push(`raw-close:${fd}`);
        if (options.rawCloseThrows)
          throw new Error('raw fd close failed');
      },
      PRIORITY_DEFAULT: 0,
      SOURCE_REMOVE: false,
      timeout_add(_priority, milliseconds, callback) {
        events.push(`timeout-add:${milliseconds}`);
        timeoutCallback = callback;
        return 73;
      },
      source_remove(id) {
        events.push(`timeout-remove:${id}`);
        return true;
      },
    },
    GObject: {
      Object: class {},
      registerClass(...args) { return args.at(-1); },
    },
    Meta: { WindowType: {}, WindowClientType: {} },
    Shell: {
      Screenshot: class {
        screenshot(_includeCursor, outputStream, callback) {
          events.push('screenshot');
          if (options.screenshotThrows)
            throw new Error('screenshot start failed');
          assert.equal(outputStream, stream);
          screenshotCallback = callback;
        }
        screenshot_finish() {
          events.push('finish');
          if (options.finishThrows)
            throw new Error('screenshot finish failed');
          return options.screenshotResult ?? [true, ''];
        }
      },
    },
    Extension: class {},
    Main: {},
    global: {},
    log() {},
  };
  const executable = source
    .replace(/^import .*;\s*$/gm, '')
    .replace('export default class CodexWindowControlExtension', 'class CodexWindowControlExtension')
    + '\nglobalThis.WindowControlDBus = WindowControlDBus;';
  const sandbox = vm.createContext(context);
  vm.runInContext(executable, sandbox, { filename: 'extension.js' });
  return {
    events,
    handler: Object.create(vm.runInContext('WindowControlDBus.prototype', sandbox)),
    invocation,
    callback: () => screenshotCallback?.(null, {}),
    timeout: () => timeoutCallback?.(),
    replies: () => replies,
    streamNamespace: () => streamNamespace,
    get rawFd() { return rawFd; },
  };
}

test('CaptureScreenshotToFd closes and flushes the duplicated fd before replying', async () => {
  const harness = await loadHandler();
  harness.handler.CaptureScreenshotToFdAsync([0], harness.invocation);

  assert.deepEqual(harness.events, [
    'get:0', 'stream:41:true', 'timeout-add:20000', 'screenshot',
  ]);
  assert.equal(harness.replies(), 0);
  harness.callback();

  assert.deepEqual(harness.events, [
    'get:0', 'stream:41:true', 'timeout-add:20000', 'screenshot',
    'timeout-remove:73', 'finish', 'flush', 'close', 'reply',
  ]);
  assert.deepEqual(Array.from(harness.invocation.result), [true, 'Screenshot captured']);
  assert.equal(harness.replies(), 1);
});

test('CaptureScreenshotToFd uses the legacy Gio stream when GioUnix is unavailable', async () => {
  for (const options of [{ gioUnixAbsent: true }, { gioUnixThrows: true }]) {
    const harness = await loadHandler(options);
    harness.handler.CaptureScreenshotToFdAsync([0], harness.invocation);
    harness.callback();

    assert.equal(harness.streamNamespace(), 'Gio.UnixOutputStream');
    assert.equal(harness.invocation.result[0], true);
    assert.equal(harness.replies(), 1);
  }
});

test('CaptureScreenshotToFd rejects absent and out-of-range fd lists before get', async () => {
  for (const [options, fdIndex] of [
    [{ fdList: null }, 0],
    [{ fdLength: 1 }, 1],
    [{}, -1],
    [{}, 0.5],
  ]) {
    const harness = await loadHandler(options);
    harness.handler.CaptureScreenshotToFdAsync([fdIndex], harness.invocation);
    assert.deepEqual(harness.events, ['reply']);
    assert.equal(harness.invocation.result[0], false);
    assert.equal(harness.replies(), 1);
  }
});

test('CaptureScreenshotToFd closes the duplicated raw fd when stream construction fails', async () => {
  const harness = await loadHandler({ streamThrows: true });
  harness.handler.CaptureScreenshotToFdAsync([0], harness.invocation);

  assert.deepEqual(harness.events, [
    'get:0', 'stream:41:true', 'raw-close:41', 'reply',
  ]);
  assert.equal(harness.invocation.result[0], false);
  assert.equal(harness.replies(), 1);
});

test('CaptureScreenshotToFd rejects a failed fd lookup without creating a stream', async () => {
  const harness = await loadHandler({ getThrows: true });
  harness.handler.CaptureScreenshotToFdAsync([0], harness.invocation);

  assert.deepEqual(harness.events, ['get:0', 'reply']);
  assert.equal(harness.invocation.result[0], false);
  assert.equal(harness.replies(), 1);
});

test('CaptureScreenshotToFd closes its stream when screenshot startup or callback fails', async () => {
  for (const options of [{ screenshotThrows: true }, { finishThrows: true }]) {
    const harness = await loadHandler(options);
    harness.handler.CaptureScreenshotToFdAsync([0], harness.invocation);
    if (!options.screenshotThrows)
      harness.callback();

    assert.equal(harness.events.includes('timeout-remove:73'), true);
    assert.equal(harness.events.at(-2), 'close');
    assert.equal(harness.events.at(-1), 'reply');
    assert.equal(harness.invocation.result[0], false);
    assert.equal(harness.replies(), 1);
  }
});

test('CaptureScreenshotToFd reports writer and close errors with one reply', async () => {
  for (const options of [{ flushThrows: true }, { closeThrows: true }]) {
    const harness = await loadHandler(options);
    harness.handler.CaptureScreenshotToFdAsync([0], harness.invocation);
    harness.callback();

    assert.equal(harness.events.at(-1), 'reply');
    assert.equal(harness.invocation.result[0], false);
    assert.equal(harness.replies(), 1);
  }
});

test('CaptureScreenshotToFd closes and replies once when the screenshot callback times out', async () => {
  const harness = await loadHandler();
  harness.handler.CaptureScreenshotToFdAsync([0], harness.invocation);
  assert.equal(harness.replies(), 0);

  harness.timeout();

  assert.deepEqual(harness.events, [
    'get:0', 'stream:41:true', 'timeout-add:20000', 'screenshot', 'close', 'reply',
  ]);
  assert.equal(harness.invocation.result[0], false);
  assert.equal(harness.replies(), 1);
});

test('CaptureScreenshotToFd finishes a late callback after timeout without reusing the closed stream', async () => {
  const harness = await loadHandler();
  harness.handler.CaptureScreenshotToFdAsync([0], harness.invocation);
  harness.timeout();

  harness.callback();

  assert.deepEqual(harness.events, [
    'get:0', 'stream:41:true', 'timeout-add:20000', 'screenshot', 'close', 'reply', 'finish',
  ]);
  assert.equal(harness.replies(), 1);
  assert.equal(harness.events.filter(event => event === 'close').length, 1);
});
