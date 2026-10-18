import SwiftUI

struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var urlText = ""
    @State private var token = ""
    @State private var connecting = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                TextField("https://mac.tailnet.ts.net", text: $urlText)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Daemon")
            } footer: {
                Text("The token is the contents of `token` in the daemon's state directory (~/.monad/token). It is kept in this device's Keychain.")
            }

            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button {
                    Task { await connect() }
                } label: {
                    HStack {
                        Text("Connect")
                        if connecting {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(connecting || urlText.isEmpty || token.isEmpty)
            }

            Section("Reaching the daemon") {
                Text("monadd listens on 127.0.0.1 only. In the Simulator on the same Mac, use http://127.0.0.1:7331. From a phone, publish it on your tailnet with HTTPS, for example `tailscale serve --bg 7331` on the Mac, and use the https address it prints.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Connect")
        .onAppear { if urlText.isEmpty { urlText = model.savedURL } }
    }

    private func connect() async {
        connecting = true
        error = nil
        defer { connecting = false }
        do {
            try await model.connect(urlText: urlText, token: token)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
