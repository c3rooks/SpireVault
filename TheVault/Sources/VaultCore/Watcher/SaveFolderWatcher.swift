import Foundation

/// Lightweight folder watcher built on `DispatchSource.makeFileSystemObjectSource`.
/// Re-scans the folder on any write/extend/rename event, debounced to ~500ms.
///
/// Not a perfect "what changed" diff — it just re-runs the parser on the whole
/// folder when anything inside changes. That's plenty for STS2's run-volume
/// (a few files per day) and avoids us reimplementing FSEvents.
public final class SaveFolderWatcher {

    public typealias OnChange = ([URL]) -> Void

    private let folder: URL
    private let queue = DispatchQueue(label: "vault.watcher")
    private var source: DispatchSourceFileSystemObject?
    private var fd: Int32 = -1
    private var debounceItem: DispatchWorkItem?
    private let onChange: OnChange

    public init(folder: URL, onChange: @escaping OnChange) {
        self.folder = folder
        self.onChange = onChange
    }

    public func start() {
        stop()
        let path = folder.path
        fd = open(path, O_EVTONLY)
        guard fd >= 0 else {
            FileHandle.standardError.write(Data("vault: cannot open \(path) for watching\n".utf8))
            return
        }
        let s = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .rename, .delete],
            queue: queue
        )
        s.setEventHandler { [weak self] in self?.scheduleScan() }
        s.setCancelHandler { [weak self] in
            if let fd = self?.fd, fd >= 0 { close(fd) }
            self?.fd = -1
        }
        source = s
        s.resume()
        // Initial scan so callers get current state without an event.
        scheduleScan()
    }

    public func stop() {
        debounceItem?.cancel()
        debounceItem = nil
        source?.cancel()
        source = nil
    }

    private func scheduleScan() {
        debounceItem?.cancel()
        let item = DispatchWorkItem { [folder, onChange] in
            let files = SaveFolderLocator.enumerateSaveFiles(in: folder)
            onChange(files)
        }
        debounceItem = item
        queue.asyncAfter(deadline: .now() + .milliseconds(500), execute: item)
    }

    deinit { stop() }
}
