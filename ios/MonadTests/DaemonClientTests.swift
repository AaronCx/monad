import Foundation
import Testing
@testable import Monad

/// Records every request and answers with a fixed status and body.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { _requests } }

    func client(status: Int = 200, body: String, base: String = "http://127.0.0.1:7331") -> DaemonClient {
        DaemonClient(baseURL: URL(string: base)!, token: "t0ken") { [self] request in
            lock.withLock { _requests.append(request) }
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), response)
        }
    }
}

// Response bodies in the shape monadd 0.1.0 (monad Link) sends.
private let statusBody = #"{"version":"0.1.0","startedAt":"2026-10-14T18:44:28.355Z","uptimeMs":360357497,"activeBackends":[{"sessionId":"01a13bbb-0227-7000-a31e-9f2cb993326d","backend":"claude-acp"}]}"#
private let listBody = #"{"sessions":[{"id":"older","cwd":"/Users/acx","backend":"import:claude-code","mode":"interactive","status":"imported","trust":"trusted","title":"older one","titleSource":"import","createdAt":"2026-10-11T20:27:40.427Z","updatedAt":"2026-10-12T09:42:34.839Z"},{"id":"newer","cwd":"/Users/acx/repo","backend":"claude-acp","agentSessionId":"x","mode":"interactive","status":"idle","trust":"trusted","parentId":"older","createdAt":"2026-10-14T18:44:33.959Z","updatedAt":"2026-10-14T18:45:22.523Z"}],"repos":{"newer":["/Users/acx/repo"]},"handoffs":{"newer":"idle: last asked"}}"#
private let transcriptBody = #"{"sessionId":"newer","title":"t","text":"[seq 1] user: hi","entries":1,"fromSeq":0,"toSeq":1,"nextFromSeq":null}"#
private let searchBody = #"{"hits":[{"sessionId":"newer","title":"t","kind":"prompt","firstSeq":12,"lastSeq":12,"ts":"2026-08-06T21:19:25.758Z","snippet":"...able to «scroll»...","startedAt":"2026-07-29T15:05:55.417Z","lastActiveAt":"2026-08-10T22:28:26.546Z"}]}"#

@Suite("DaemonClient")
struct DaemonClientTests {
    @Test("status sends the bearer token to /v1/status and decodes the reply")
    func status() async throws {
        let recorder = Recorder()
        let status = try await recorder.client(body: statusBody).status()
        #expect(status.version == "0.1.0")
        #expect(status.activeBackends.map(\.backend) == ["claude-acp"])
        let request = try #require(recorder.requests.first)
        #expect(request.url?.absoluteString == "http://127.0.0.1:7331/v1/status")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer t0ken")
    }

    @Test("sessions asks for the Link list, sorts most recent first, and keeps repos and handoffs")
    func sessions() async throws {
        let recorder = Recorder()
        let list = try await recorder.client(body: listBody).sessions(includeImported: false)
        #expect(list.sessions.map(\.id) == ["newer", "older"])
        #expect(list.repos["newer"] == ["/Users/acx/repo"])
        #expect(list.handoffs["newer"] == "idle: last asked")
        #expect(list.sessions[0].parentId == "older")
        #expect(list.sessions[0].displayTitle == "untitled")
        #expect(list.sessions[1].isImported)
        let url = try #require(recorder.requests.first?.url)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(url.path == "/v1/sessions")
        #expect(items.contains(URLQueryItem(name: "imported", value: "0")))
        #expect(items.contains(URLQueryItem(name: "limit", value: "200")))
    }

    @Test("a daemon without Link sends no repos or handoffs, and the list still decodes")
    func sessionsWithoutLink() async throws {
        let body = #"{"sessions":[{"id":"a","cwd":"/","backend":"claude-acp","mode":"review","status":"running","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]}"#
        let list = try await Recorder().client(body: body).sessions(includeImported: true)
        #expect(list.sessions.count == 1)
        #expect(list.repos.isEmpty && list.handoffs.isEmpty)
    }

    @Test("transcript pages by seq and reports the end of the log")
    func transcript() async throws {
        let recorder = Recorder()
        let page = try await recorder.client(body: transcriptBody).transcript(sessionId: "newer", from: 40)
        #expect(page.text == "[seq 1] user: hi")
        #expect(page.nextFromSeq == nil)
        let url = try #require(recorder.requests.first?.url)
        #expect(url.path == "/v1/sessions/newer/transcript")
        #expect(url.query?.contains("from=40") == true)
    }

    @Test("search encodes the query, plus signs included, and decodes provenance")
    func search() async throws {
        let recorder = Recorder()
        let hits = try await recorder.client(body: searchBody).search("c++ scroll & more")
        #expect(hits.first?.firstSeq == 12)
        #expect(hits.first?.startedAt == "2026-07-29T15:05:55.417Z")
        let url = try #require(recorder.requests.first?.url)
        #expect(url.absoluteString.contains("q=c%2B%2B%20scroll%20%26%20more"))
    }

    @Test("a base path on the daemon address is kept")
    func basePath() async throws {
        let recorder = Recorder()
        _ = try await recorder.client(body: statusBody, base: "https://mac.example.ts.net/monad").status()
        #expect(recorder.requests.first?.url?.absoluteString == "https://mac.example.ts.net/monad/v1/status")
    }

    @Test("401 is a refused token, 404 is not found, other errors carry the daemon's message")
    func errors() async {
        await #expect(throws: DaemonError.unauthorized) {
            try await Recorder().client(status: 401, body: #"{"error":"unauthorized"}"#).status()
        }
        await #expect(throws: DaemonError.notFound("not found")) {
            try await Recorder().client(status: 404, body: #"{"error":"not found"}"#).transcript(sessionId: "x", from: 0)
        }
        await #expect(throws: DaemonError.http(status: 500, message: "boom")) {
            try await Recorder().client(status: 500, body: #"{"error":"boom"}"#).status()
        }
        do {
            _ = try await Recorder().client(body: "not json").status()
            Issue.record("expected an error")
        } catch {
            guard case .undecodable = error else { Issue.record("got \(error)"); return }
        }
    }

    @Test("a transport failure is reported as unreachable")
    func unreachable() async {
        let client = DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "t") { _ in
            throw URLError(.cannotConnectToHost)
        }
        do {
            _ = try await client.status()
            Issue.record("expected an error")
        } catch {
            guard case .unreachable = error else { Issue.record("got \(error)"); return }
        }
    }
}

@Suite("parseBaseURL")
struct ParseBaseURLTests {
    @Test("accepts http and https and drops trailing slashes", arguments: [
        ("http://127.0.0.1:7331", "http://127.0.0.1:7331"),
        (" https://mac.example.ts.net/ ", "https://mac.example.ts.net"),
        ("HTTPS://mac.example.ts.net/monad//", "https://mac.example.ts.net/monad"),
        ("http://localhost:7331", "http://localhost:7331"),
        ("http://[::1]:7331", "http://[::1]:7331"),
    ])
    func accepts(input: String, expected: String) throws {
        #expect(try DaemonClient.parseBaseURL(input).absoluteString == expected)
    }

    @Test("refuses anything that is not an http(s) address with a host, and plain http off this device", arguments: [
        "", "127.0.0.1:7331", "ftp://host", "http://", "https://host/?q=1", "monad",
        "http://mac.local:7331", "http://192.168.1.20:7331", "http://100.64.0.1:7331", "http://mac.example.ts.net",
    ])
    func refuses(input: String) {
        #expect(throws: DaemonError.self) { try DaemonClient.parseBaseURL(input) }
    }
}

@Suite("Transport")
struct TransportTests {
    @Test("real requests go through a session that writes nothing to disk")
    func ephemeralSession() {
        let configuration = DaemonClient.session.configuration
        #expect(configuration.urlCache == nil)
        #expect(configuration.requestCachePolicy == .reloadIgnoringLocalCacheData)
        #expect(configuration.httpCookieStorage == nil)
    }
}

@Suite("Timestamp")
struct TimestampTests {
    @Test("parses daemon timestamps with and without fractional seconds")
    func parses() {
        #expect(Timestamp.parse("2026-10-14T18:44:28.355Z") != nil)
        #expect(Timestamp.parse("2026-10-14T18:44:28Z") != nil)
        #expect(Timestamp.parse("yesterday") == nil)
        #expect(Timestamp.relative("yesterday") == "yesterday")
    }
}
