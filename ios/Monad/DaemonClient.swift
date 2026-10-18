import Foundation

/// Why a control API call failed, phrased for the person holding the phone.
enum DaemonError: Error, Equatable, LocalizedError {
    case invalidURL(String)
    case unauthorized
    case notFound(String)
    case http(status: Int, message: String)
    case unreachable(String)
    case undecodable(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let text):
            "\"\(text)\" is not a daemon address. Use http://127.0.0.1:7331 in the Simulator, or the https address the daemon is published on."
        case .unauthorized:
            "The daemon refused the token. Copy it again from the token file in the daemon's state directory (~/.monad/token)."
        case .notFound(let message):
            "The daemon has no such resource: \(message). An older daemon without monad Link has no transcripts or search."
        case .http(let status, let message):
            "The daemon answered \(status): \(message)"
        case .unreachable(let message):
            "Could not reach the daemon: \(message). monadd listens on 127.0.0.1 only, so a phone needs a route to it, such as tailscale serve on the Mac."
        case .undecodable(let message):
            "The daemon's reply could not be read: \(message)"
        }
    }
}

/// A client for monadd's control API (`/v1/...`, bearer token). Read-only:
/// status, the session list, transcripts and search.
struct DaemonClient: Sendable {
    typealias Send = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    let baseURL: URL
    private let token: String
    private let send: Send

    init(baseURL: URL, token: String, send: @escaping Send = { try await URLSession.shared.data(for: $0) }) {
        self.baseURL = baseURL
        self.token = token
        self.send = send
    }

    /// Parses what a person typed as the daemon address: a scheme is required
    /// and only http and https are accepted; a trailing slash is dropped.
    static func parseBaseURL(_ text: String) throws(DaemonError) -> URL {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              components.query == nil, components.fragment == nil
        else { throw .invalidURL(trimmed) }
        var clean = components
        clean.scheme = scheme
        while clean.path.hasSuffix("/") { clean.path.removeLast() }
        guard let url = clean.url else { throw .invalidURL(trimmed) }
        return url
    }

    func status() async throws(DaemonError) -> DaemonStatus {
        try await get("/v1/status", [])
    }

    /// Most recently active first. A limit selects the Link list (with repos
    /// and handoffs); `imported=0` hides imported vendor logs.
    func sessions(limit: Int = 200, includeImported: Bool) async throws(DaemonError) -> SessionList {
        let list: SessionList = try await get("/v1/sessions", [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "imported", value: includeImported ? "1" : "0"),
        ])
        // A daemon without Link ignores the filters and lists oldest first.
        let sorted = list.sessions.sorted { $0.updatedAt > $1.updatedAt }
        return SessionList(sessions: sorted, repos: list.repos, handoffs: list.handoffs)
    }

    func transcript(sessionId: String, from: Int, limit: Int = 200) async throws(DaemonError) -> TranscriptPage {
        try await get("/v1/sessions/\(try pathSegment(sessionId))/transcript", [
            URLQueryItem(name: "from", value: String(from)),
            URLQueryItem(name: "limit", value: String(limit)),
        ])
    }

    func search(_ query: String, limit: Int = 50) async throws(DaemonError) -> [SearchHit] {
        let results: SearchResults = try await get("/v1/search", [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
        ])
        return results.hits
    }

    // MARK: - Plumbing

    func request(_ path: String, _ query: [URLQueryItem]) throws(DaemonError) -> URLRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw .invalidURL(baseURL.absoluteString)
        }
        components.path += path
        if !query.isEmpty { components.queryItems = query }
        // URLComponents leaves "+" alone in a query; a server reads it as a space.
        components.percentEncodedQuery = components.percentEncodedQuery?
            .replacingOccurrences(of: "+", with: "%2B")
        guard let url = components.url else { throw .invalidURL(baseURL.absoluteString) }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func pathSegment(_ id: String) throws(DaemonError) -> String {
        guard !id.isEmpty, let encoded = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(["-", "_", "."])) else {
            throw .notFound("session \(id)")
        }
        return encoded
    }

    private func get<T: Decodable>(_ path: String, _ query: [URLQueryItem]) async throws(DaemonError) -> T {
        let request = try request(path, query)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await send(request)
        } catch {
            throw .unreachable(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw .unreachable("not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(DaemonErrorBody.self, from: data))?.error
                ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            switch http.statusCode {
            case 401, 403: throw .unauthorized
            case 404: throw .notFound(message)
            default: throw .http(status: http.statusCode, message: message)
            }
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw .undecodable(String(describing: error))
        }
    }
}
