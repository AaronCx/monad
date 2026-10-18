import SwiftUI

@main
struct MonadApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let client = model.client {
                SessionsView(client: client)
                    .id(client.baseURL)
            } else {
                NavigationStack { ConnectView() }
            }
        }
        #if DEBUG
        .task { await model.connectFromLaunchEnvironment() }
        #endif
    }
}
