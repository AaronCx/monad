import SwiftUI

struct SessionDetailView: View {
    let client: DaemonClient
    let route: SessionRoute
    let repos: [String]
    let handoff: String?

    @State private var pages: [TranscriptPage] = []
    @State private var error: String?
    @State private var loading = false

    private var nextFromSeq: Int? { pages.last?.nextFromSeq }

    var body: some View {
        List {
            if let session = route.session {
                metadata(session)
            } else {
                Section {
                    LabeledContent("Session", value: String(route.sessionId.prefix(13)))
                }
            }
            transcript
        }
        .navigationTitle(route.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { if pages.isEmpty { await load(from: route.fromSeq) } }
        .refreshable {
            pages = []
            await load(from: route.fromSeq)
        }
    }

    private func metadata(_ session: Session) -> some View {
        Section {
            LabeledContent("Status") { StatusBadge(status: session.status) }
            LabeledContent("Backend", value: session.backend)
            LabeledContent("Mode", value: session.mode)
            LabeledContent("Directory", value: session.cwd)
            if !repos.isEmpty {
                LabeledContent("Repos", value: repos.joined(separator: "\n"))
            }
            if let parent = session.parentId {
                LabeledContent("Spawned by", value: String(parent.prefix(13)))
            }
            LabeledContent("Last active", value: Timestamp.relative(session.updatedAt))
            if let handoff {
                Text(handoff).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private var transcript: some View {
        Section(route.fromSeq > 0 ? "Transcript from seq \(String(route.fromSeq))" : "Transcript") {
            ForEach(pages.indices, id: \.self) { index in
                Text(pages[index].text.isEmpty ? "(no entries)" : pages[index].text)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
            }
            if loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let next = nextFromSeq {
                Button("Load more") { Task { await load(from: next) } }
            } else if !pages.isEmpty {
                Text("End of the session's log.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func load(from seq: Int) async {
        loading = true
        defer { loading = false }
        do {
            pages.append(try await client.transcript(sessionId: route.sessionId, from: seq))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
