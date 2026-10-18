import SwiftUI

struct SessionsView: View {
    let client: DaemonClient
    @Environment(AppModel.self) private var model
    @State private var list: SessionList?
    @State private var includeImported = false
    @State private var error: String?
    @State private var loading = false
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            List {
                if let status = model.status {
                    Section {
                        StatusSummary(status: status, url: client.baseURL)
                    }
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
                if let list {
                    Section(list.sessions.isEmpty ? "No sessions" : "Sessions") {
                        ForEach(list.sessions) { session in
                            NavigationLink(value: SessionRoute(session: session)) {
                                SessionRow(
                                    session: session,
                                    repos: list.repos[session.id] ?? [],
                                    handoff: list.handoffs[session.id]
                                )
                            }
                            .accessibilityIdentifier("session-row")
                        }
                    }
                } else if loading {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("monad")
            .navigationDestination(for: SessionRoute.self) { route in
                SessionDetailView(client: client, route: route, repos: list?.repos[route.sessionId] ?? [], handoff: list?.handoffs[route.sessionId])
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Toggle("Include imported logs", isOn: $includeImported)
                        Button("Disconnect", role: .destructive) { model.disconnect() }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SearchView(client: client)
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .accessibilityLabel("Search")
                }
            }
            .refreshable { await load() }
            .task(id: includeImported) { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        await model.refreshStatus()
        do {
            list = try await client.sessions(includeImported: includeImported)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// A session to open, and the seq to start reading at. A search hit opens at
/// its row and carries no session record (the control API has no single
/// session read), so the detail view shows only what the hit knows.
struct SessionRoute: Hashable {
    let sessionId: String
    let title: String
    let session: Session?
    let fromSeq: Int

    init(session: Session) {
        sessionId = session.id
        title = session.displayTitle
        self.session = session
        fromSeq = 0
    }

    init(hit: SearchHit) {
        sessionId = hit.sessionId
        title = hit.title ?? "untitled"
        session = nil
        fromSeq = hit.firstSeq
    }
}

struct StatusSummary: View {
    let status: DaemonStatus
    let url: URL

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("monadd \(status.version)").font(.headline)
            Text(url.absoluteString).font(.caption).foregroundStyle(.secondary)
            Text("up since \(Timestamp.relative(status.startedAt)) · \(status.activeBackends.count) live")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

struct SessionRow: View {
    let session: Session
    let repos: [String]
    let handoff: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(session.displayTitle)
                .font(.body)
                .lineLimit(2)
            HStack(spacing: 6) {
                StatusBadge(status: session.status)
                Text(session.backend)
                Text("·")
                Text(Timestamp.relative(session.updatedAt))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if !repos.isEmpty {
                Text(repos.map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(status.replacingOccurrences(of: "_", with: " "))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case "running": .green
        case "waiting_for_permission": .orange
        case "error", "failed": .red
        case "idle": .blue
        default: .gray
        }
    }
}
