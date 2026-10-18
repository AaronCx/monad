import Foundation

/// GET /v1/status.
struct DaemonStatus: Decodable, Sendable, Equatable {
    struct ActiveBackend: Decodable, Sendable, Equatable {
        let sessionId: String
        let backend: String
    }

    let version: String
    let startedAt: String
    let uptimeMs: Double
    let activeBackends: [ActiveBackend]
}

/// One session record, as GET /v1/sessions returns it. Only the fields the
/// app shows are decoded; the daemon may send more.
struct Session: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let cwd: String
    let backend: String
    let mode: String
    let status: String
    let title: String?
    let parentId: String?
    let createdAt: String
    let updatedAt: String

    var displayTitle: String {
        guard let title, !title.isEmpty else { return "untitled" }
        return title
    }

    /// Imported vendor logs (`import:claude-code`, `import:codex`) are read-only history.
    var isImported: Bool { backend.hasPrefix("import:") }
}

/// GET /v1/sessions. `repos` and `handoffs` are keyed by session id; a daemon
/// without monad Link sends neither.
struct SessionList: Decodable, Sendable {
    let sessions: [Session]
    let repos: [String: [String]]
    let handoffs: [String: String]

    private enum CodingKeys: String, CodingKey { case sessions, repos, handoffs }

    init(sessions: [Session], repos: [String: [String]] = [:], handoffs: [String: String] = [:]) {
        self.sessions = sessions
        self.repos = repos
        self.handoffs = handoffs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try c.decode([Session].self, forKey: .sessions)
        repos = try c.decodeIfPresent([String: [String]].self, forKey: .repos) ?? [:]
        handoffs = try c.decodeIfPresent([String: String].self, forKey: .handoffs) ?? [:]
    }
}

/// GET /v1/sessions/<id>/transcript: one page of the normalized, redacted
/// transcript. `nextFromSeq` is nil at the end of the log.
struct TranscriptPage: Decodable, Sendable, Equatable {
    let sessionId: String
    let title: String?
    let text: String
    let entries: Int
    let fromSeq: Int
    let toSeq: Int?
    let nextFromSeq: Int?
}

/// One hit of GET /v1/search.
struct SearchHit: Decodable, Sendable, Identifiable, Hashable {
    let sessionId: String
    let title: String?
    let kind: String
    let firstSeq: Int
    let lastSeq: Int
    let ts: String
    let snippet: String
    let parentId: String?
    let startedAt: String?
    let lastActiveAt: String?

    var id: String { "\(sessionId):\(firstSeq):\(kind)" }
}

struct SearchResults: Decodable, Sendable {
    let hits: [SearchHit]
}

/// The daemon's error body: `{ "error": "..." }`.
struct DaemonErrorBody: Decodable, Sendable {
    let error: String
}

enum Timestamp {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()

    static func parse(_ text: String) -> Date? {
        (try? fractional.parse(text)) ?? (try? whole.parse(text))
    }

    /// "3 min ago" style text for a daemon timestamp, or the raw text if it does not parse.
    static func relative(_ text: String, now: Date = .now) -> String {
        guard let date = parse(text) else { return text }
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}
