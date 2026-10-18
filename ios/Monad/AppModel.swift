import Foundation
import Observation

/// The app's one piece of shared state: where the daemon is and how to reach it.
@MainActor
@Observable
final class AppModel {
    private static let urlKey = "daemonURL"

    private(set) var client: DaemonClient?
    private(set) var status: DaemonStatus?

    var savedURL: String { UserDefaults.standard.string(forKey: Self.urlKey) ?? "" }

    init() {
        if let url = try? DaemonClient.parseBaseURL(savedURL), let token = TokenStore.load() {
            client = DaemonClient(baseURL: url, token: token)
        }
    }

    /// Checks the address and token against /v1/status, and keeps them only if the daemon accepts them.
    func connect(urlText: String, token: String) async throws(DaemonError) {
        let url = try DaemonClient.parseBaseURL(urlText)
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw .unauthorized }
        let candidate = DaemonClient(baseURL: url, token: trimmed)
        let status = try await candidate.status()
        UserDefaults.standard.set(url.absoluteString, forKey: Self.urlKey)
        TokenStore.save(trimmed)
        self.status = status
        client = candidate
    }

    func refreshStatus() async {
        guard let client else { return }
        status = try? await client.status()
    }

    func disconnect() {
        TokenStore.delete()
        client = nil
        status = nil
    }

    #if DEBUG
    /// Debug builds only: `simctl launch` with SIMCTL_CHILD_MONAD_DAEMON_URL and
    /// SIMCTL_CHILD_MONAD_DAEMON_TOKEN connects without typing, for driving the
    /// app against a local daemon in the Simulator. Compiled out of Release.
    func connectFromLaunchEnvironment() async {
        let env = ProcessInfo.processInfo.environment
        guard client == nil, let url = env["MONAD_DAEMON_URL"], let token = env["MONAD_DAEMON_TOKEN"] else { return }
        try? await connect(urlText: url, token: token)
    }
    #endif
}
