// macOS harness for App_Resources/iOS/src/FaceclawSystemLanguageModel.swift: runs one
// assistant request against the Apple Intelligence model the way local-llm.ios.ts does,
// answering every tool call with a canned result. See run.sh.
import Foundation

@main struct Harness {
    @MainActor static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 3 else {
            print("usage: harness <tools.json> <prompt> [previous prompt]")
            return
        }
        print("availability:", FaceclawSystemLanguageModel.availability(),
              "context:", FaceclawSystemLanguageModel.contextSize())
        let tools = (try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[1])))) ?? []
        var history: [[String: Any]] = []
        if args.count > 3 { history = [["type": "prompt", "text": args[3]], ["type": "response", "text": "OK."]] }
        let request: [String: Any] = [
            "system": "You are the voice assistant built into a pair of Even Realities G2 smart glasses. Your reply is shown as text on a 640x480 monochrome heads-up display and may also be read aloud, so keep it short: 1-3 plain sentences, no markdown, no bullet lists unless the user explicitly asks for a list. Prefer doing things with the tools you have over describing how the user could do them; when a tool can answer or act, use it. If a tool fails or a capability is missing, say so briefly rather than inventing a result.",
            "tools": tools, "history": history, "prompt": args[2], "maxTokens": 512, "permissive": false,
        ]
        let model = FaceclawSystemLanguageModel()
        let started = Date()
        var finished = false
        var firstText: TimeInterval?
        model.eventHandler = { json in
            let elapsed = String(format: "%6.2fs", Date().timeIntervalSince(started))
            guard let event = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return }
            switch event["kind"] as? String {
            case "delta":
                if firstText == nil { firstText = Date().timeIntervalSince(started); print("\(elapsed) first text") }
                print(event["text"] as? String ?? "", terminator: "")
            case "toolCalls":
                let calls = event["calls"] as? [[String: Any]] ?? []
                for call in calls { print("\(elapsed) tool call: \(call["name"] ?? "") \(call["arguments"] ?? "")") }
                let results = calls.map { ["id": $0["id"] ?? "", "content": "Done (simulated \($0["name"] ?? "tool") result).", "isError": false] }
                let data = try! JSONSerialization.data(withJSONObject: results)
                model.resolveToolCalls(String(data: data, encoding: .utf8)!)
            case "done":
                print("\n\(elapsed) done"); finished = true
            default:
                print("\(elapsed) \(json)")
                if event["kind"] as? String == "error" { finished = true }
            }
        }
        let data = try! JSONSerialization.data(withJSONObject: request)
        model.start(String(data: data, encoding: .utf8)!)
        while !finished && Date().timeIntervalSince(started) < 120 { try? await Task.sleep(nanoseconds: 50_000_000) }
    }
}
