import UniformTypeIdentifiers
import WebKit

/// Serves the bundled web app (web/, built by `bun run build:app`) at izine://app/.
/// A fixed origin of its own: localStorage and IndexedDB (the zine library) persist
/// across launches and app updates, exactly as on the web.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "izine"
    static let start = URL(string: "izine://app/index.html")!
    private let root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true).standardizedFileURL

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
            task.didFinish()
            return
        }
        let mime: String
        switch file.pathExtension.lowercased() {
        case "js", "mjs": mime = "text/javascript"
        case "css": mime = "text/css"
        case "html": mime = "text/html"
        default: mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
        let headers = ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
