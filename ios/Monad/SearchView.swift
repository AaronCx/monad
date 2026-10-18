import SwiftUI

struct SearchView: View {
    let client: DaemonClient
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var searched = false
    @State private var error: String?
    @State private var opening: SessionRoute?

    var body: some View {
        List {
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
            } else if searched && hits.isEmpty {
                Text("No hits").foregroundStyle(.secondary)
            }
            ForEach(hits) { hit in
                Button {
                    opening = SessionRoute(hit: hit)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(hit.title ?? "untitled").font(.subheadline).lineLimit(1)
                        Text(hit.snippet.replacingOccurrences(of: "«", with: "").replacingOccurrences(of: "»", with: ""))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                        Text("\(hit.kind) · seq \(String(hit.firstSeq)) · \(Timestamp.relative(hit.ts))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .tint(.primary)
            }
        }
        .navigationTitle("Search")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search session history")
        .onSubmit(of: .search) { Task { await search() } }
        .navigationDestination(item: $opening) { route in
            SessionDetailView(client: client, route: route, repos: [], handoff: nil)
        }
    }

    private func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            hits = try await client.search(trimmed)
            error = nil
        } catch {
            hits = []
            self.error = error.localizedDescription
        }
        searched = true
    }
}
