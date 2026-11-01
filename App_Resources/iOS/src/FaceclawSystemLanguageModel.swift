import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// The on-phone LLM on iOS: Apple's Foundation Models framework (the Apple
/// Intelligence system model, iOS 26+, eligible hardware). It runs out of
/// process on the Neural Engine, so it costs the app no model download or
/// memory, and unlike Metal work it is allowed (within a system budget) while
/// Faceclaw is in the background driving the glasses.
///
/// JavaScript (app/native/local-llm.ios.ts) drives the same provider-neutral
/// agent loop as the cloud models: each start() is one loop iteration. The
/// request is JSON:
///
///   {"system":String,
///    "tools":[{"name","description","parameters":<JSON Schema>}],
///    "history":[{"type":"prompt"|"response","text"} |
///               {"type":"toolCalls","calls":[{"id","name","arguments":<JSON string>}]} |
///               {"type":"toolOutput","id","name","text"}],
///    "prompt":String, "maxTokens":Int, "permissive":Bool}
///
/// and events arrive on the main queue through eventHandler:
///
///   {"kind":"delta","text":String}              streamed reply text
///   {"kind":"toolCalls","calls":[{"id","name","arguments":<JSON string>}]}
///   {"kind":"done"}
///   {"kind":"error","code":String,"message":String}
///   {"kind":"log","message":String}
///
/// The framework runs tools itself, mid-response. When the model calls one,
/// the call is reported as "toolCalls" and the generation stays suspended
/// inside the tool until resolveToolCalls() hands back the results that
/// JavaScript's tool loop produced; the reply then continues on the same
/// instance.
///
/// The model's context window is small (4096 tokens on iOS 26, shared by input
/// and reply) and the framework spends ~50 tokens on each tool before its
/// parameters, so the assistant's full tool list (30+ tools, ~5000 tokens) can't
/// be offered at once. When the tools don't fit their share of the window, a
/// quick schema-constrained routing request first asks the model which few
/// tools the request needs. History is then trimmed to fit before each start().
/// Called from JavaScript, so on the main thread.
@MainActor
@objc(FaceclawSystemLanguageModel)
@objcMembers
public class FaceclawSystemLanguageModel: NSObject {
    public var eventHandler: ((String) -> Void)?
    // A LanguageModelEngine, typed loosely so the class itself loads before iOS 26.
    private var engine: AnyObject?

    /// "available", or why not: "unsupportedOS", "deviceNotEligible",
    /// "appleIntelligenceNotEnabled", "modelNotReady" (still downloading), "unavailable".
    /// Nonisolated: worker isolates load the model-choice list too, off the main thread.
    nonisolated public static func availability() -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return "available"
            case .unavailable(let reason):
                switch reason {
                case .deviceNotEligible: return "deviceNotEligible"
                case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
                case .modelNotReady: return "modelNotReady"
                @unknown default: return "unavailable"
                }
            }
        }
        #endif
        return "unsupportedOS"
    }

    /// The model's context window in tokens (input and output share it), or 0 when unavailable.
    nonisolated public static func contextSize() -> Int {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) { return SystemLanguageModel.default.contextSize }
        #endif
        return 0
    }

    public func start(_ requestJson: String) {
        cancel()
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            guard let data = requestJson.data(using: .utf8),
                  let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                emit(["kind": "error", "code": "other", "message": "Invalid on-device model request"])
                return
            }
            let engine = LanguageModelEngine { [weak self] event in self?.emit(event) }
            self.engine = engine
            engine.start(request)
            return
        }
        #endif
        emit(["kind": "error", "code": "unavailable", "message": "The on-device model needs iOS 26 or later."])
    }

    /// `[{"id","content","isError"}]` for the calls of the last "toolCalls" event.
    public func resolveToolCalls(_ resultsJson: String) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let data = resultsJson.data(using: .utf8) ?? Data()
            let results = ((try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]) ?? []
            (engine as? LanguageModelEngine)?.resolve(results)
        }
        #endif
    }

    /// Abandon the generation (and any suspended tool calls) without further events.
    public func cancel() {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) { (engine as? LanguageModelEngine)?.cancel() }
        #endif
        engine = nil
    }

    private func emit(_ event: [String: Any]) {
        // JSONSerialization raises (not throws) on NaN and other invalid values.
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8) else { return }
        eventHandler?(json)
    }
}

#if canImport(FoundationModels)

/// A JavaScript-side tool: the framework calls it mid-response, and the
/// engine parks the call until JavaScript resolves it.
@available(iOS 26.0, *)
private struct BridgedTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema
    let handler: @Sendable (String, String) async throws -> String

    func call(arguments: GeneratedContent) async throws -> String {
        try await handler(name, arguments.jsonString)
    }
}

/// One tool from the request, convertible at two levels of verbosity.
@available(iOS 26.0, *)
private struct ToolSpec {
    let name: String
    let description: String
    let parameters: [String: Any]
}

@available(iOS 26.0, *)
@MainActor
final class LanguageModelEngine {
    private struct PendingCall {
        let id: String
        let name: String
        let arguments: String
        let continuation: CheckedContinuation<String, Error>
    }

    /// How long a call waits for any parallel calls before they're reported together.
    private static let toolBatchDelayNs: UInt64 = 30_000_000
    /// Tokens kept free beyond the reply budget: the framework's own framing and rounding.
    private static let contextMargin = 64
    /// Share of the context window tool definitions may take before tools are routed.
    private static let toolBudgetFraction = 0.4
    /// Most tools a routing request picks.
    private static let maxRoutedTools = 5
    /// Tools used in the latest exchanges stay offered, for follow-ups ("make it ten minutes").
    private static let keptRecentTools = 2

    private let emit: ([String: Any]) -> Void
    private var task: Task<Void, Never>?
    // Calls not yet reported, then reported calls awaiting results.
    private var unreported: [PendingCall] = []
    private var awaiting: [String: PendingCall] = [:]
    private var flushScheduled = false
    private var closed = false

    init(emit: @escaping ([String: Any]) -> Void) { self.emit = emit }

    func start(_ request: [String: Any]) {
        task = Task { [weak self] in await self?.run(request) }
    }

    func resolve(_ results: [[String: Any]]) {
        for result in results {
            guard let id = result["id"] as? String, let call = awaiting.removeValue(forKey: id) else { continue }
            let content = (result["content"] as? String) ?? ""
            let isError = (result["isError"] as? Bool) ?? false
            // An error goes back to the model as text: a thrown error would end the whole response.
            call.continuation.resume(returning: isError ? "Error: \(content)" : (content.isEmpty ? "(no output)" : content))
        }
        // A call JavaScript didn't answer can't be left hanging.
        for (_, call) in awaiting {
            call.continuation.resume(returning: "Error: the tool returned no result")
        }
        awaiting.removeAll()
    }

    func cancel() {
        closed = true
        task?.cancel()
        task = nil
        for call in unreported { call.continuation.resume(throwing: CancellationError()) }
        for (_, call) in awaiting { call.continuation.resume(throwing: CancellationError()) }
        unreported.removeAll()
        awaiting.removeAll()
    }

    /// Events stop once the session is cancelled, even from work still winding down.
    private func send(_ event: [String: Any]) {
        if !closed { emit(event) }
    }

    private func run(_ request: [String: Any]) async {
        let system = (request["system"] as? String) ?? ""
        let prompt = (request["prompt"] as? String) ?? ""
        let maxTokens = (request["maxTokens"] as? NSNumber)?.intValue ?? 512
        let permissive = (request["permissive"] as? Bool) ?? false
        let toolSpecs: [ToolSpec] = ((request["tools"] as? [[String: Any]]) ?? []).compactMap { tool in
            guard let name = tool["name"] as? String else { return nil }
            return ToolSpec(name: name, description: (tool["description"] as? String) ?? "",
                            parameters: (tool["parameters"] as? [String: Any]) ?? [:])
        }
        let history = (request["history"] as? [[String: Any]]) ?? []

        // Transformations of user text (translate, summarize) get the permissive
        // guardrails; they apply to plain string replies, which tool-free requests are.
        let model = SystemLanguageModel(useCase: .general,
                                        guardrails: permissive ? .permissiveContentTransformations : .default)
        var offered = toolSpecs
        if !toolSpecs.isEmpty {
            switch await selectTools(model: model, specs: toolSpecs, history: history, prompt: prompt) {
            case .tools(let specs): offered = specs
            case .failed(let event):
                send(event)
                return
            }
            if closed { return }
        }
        let fitted = await fit(model: model, system: system, tools: offered, history: history,
                               prompt: prompt, maxTokens: maxTokens)
        if closed { return }

        let handler: @Sendable (String, String) async throws -> String = { [weak self] name, arguments in
            guard let self = self else { throw CancellationError() }
            return try await self.toolInvoked(name: name, arguments: arguments)
        }
        let tools: [any Tool] = fitted.tools.map {
            BridgedTool(name: $0.name, description: $0.description, parameters: $0.schema, handler: handler)
        }
        let session = LanguageModelSession(model: model, tools: tools, transcript: Transcript(entries: fitted.entries))
        let options = GenerationOptions(maximumResponseTokens: maxTokens)
        var last = ""
        do {
            for try await snapshot in session.streamResponse(to: prompt, options: options) {
                if closed { return }
                let text = snapshot.content
                // Snapshots are cumulative; one that doesn't extend the last is a new segment.
                let delta = text.hasPrefix(last) ? String(text.dropFirst(last.count)) : text
                last = text
                if !delta.isEmpty { send(["kind": "delta", "text": delta]) }
            }
            send(["kind": "done"])
        } catch {
            if closed || error is CancellationError { return }
            send(describe(error))
        }
    }

    // MARK: - Tool calls

    private func toolInvoked(name: String, arguments: String) async throws -> String {
        if closed { throw CancellationError() }
        return try await withCheckedThrowingContinuation { continuation in
            if closed {
                continuation.resume(throwing: CancellationError())
                return
            }
            let id = "fm_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16).lowercased()
            unreported.append(PendingCall(id: id, name: name, arguments: arguments, continuation: continuation))
            scheduleFlush()
        }
    }

    /// Report calls in one event, after a moment for any parallel calls to arrive.
    private func scheduleFlush() {
        if flushScheduled { return }
        flushScheduled = true
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: LanguageModelEngine.toolBatchDelayNs)
            self?.flush()
        }
    }

    private func flush() {
        flushScheduled = false
        if closed || unreported.isEmpty { return }
        let calls = unreported
        unreported.removeAll()
        for call in calls { awaiting[call.id] = call }
        send(["kind": "toolCalls",
              "calls": calls.map { ["id": $0.id, "name": $0.name, "arguments": $0.arguments] }])
    }

    // MARK: - Tool routing

    private enum Selection {
        case tools([ToolSpec])
        case failed([String: Any])
    }

    /// All tools when their definitions fit their share of the context window;
    /// otherwise the few the model picks for this request, plus recently used ones.
    private func selectTools(model: SystemLanguageModel, specs: [ToolSpec], history: [[String: Any]],
                             prompt: String) async -> Selection {
        let budget = Int(Double(model.contextSize) * LanguageModelEngine.toolBudgetFraction)
        let cost = await toolTokens(model, buildTools(specs, compact: false))
        if cost <= budget { return .tools(specs) }

        let names = specs.map { $0.name }
        let catalog = specs.map { "- \($0.name): \(SchemaBuilder.shorten($0.description, sentences: 1, limit: 100))" }
            .joined(separator: "\n")
        let instructions = "You pick the tools a voice assistant needs to handle the user's latest request. " +
            "Choose at most \(LanguageModelEngine.maxRoutedTools) tools from this list that the assistant should be able to use, " +
            "most important first. Choose none for small talk or questions it can answer from general knowledge.\n\n" + catalog
        var query = prompt
        if let previous = lastPromptText(history) {
            query = "Previous request: \(SchemaBuilder.shorten(previous, sentences: 3, limit: 300))\n\nLatest request: \(prompt)"
        }
        do {
            let schema = try GenerationSchema(root: DynamicGenerationSchema(name: "ToolSelection", properties: [
                DynamicGenerationSchema.Property(
                    name: "tools", description: "Names of the tools needed, most important first.",
                    schema: DynamicGenerationSchema(arrayOf: DynamicGenerationSchema(type: String.self, guides: [.anyOf(names)]),
                                                    minimumElements: 0,
                                                    maximumElements: LanguageModelEngine.maxRoutedTools)),
            ]), dependencies: [])
            let session = LanguageModelSession(model: model, instructions: instructions)
            let response = try await session.respond(to: query, schema: schema,
                                                     options: GenerationOptions(sampling: .greedy, maximumResponseTokens: 100))
            var chosen = Set(try response.content.value([String].self, forProperty: "tools"))
            let recent = recentToolNames(history).prefix(LanguageModelEngine.keptRecentTools)
            chosen.formUnion(recent)
            let selected = specs.filter { chosen.contains($0.name) }
            send(["kind": "log", "message": "routed \(specs.count) tools (\(cost) tokens) to: " +
                  (selected.isEmpty ? "none" : selected.map { $0.name }.joined(separator: ", "))])
            return .tools(selected)
        } catch {
            if let generationError = error as? LanguageModelSession.GenerationError {
                switch generationError {
                case .rateLimited, .concurrentRequests, .assetsUnavailable, .guardrailViolation, .refusal,
                     .unsupportedLanguageOrLocale:
                    // The real request would fail the same way.
                    return .failed(describe(error))
                default:
                    break
                }
            }
            send(["kind": "log", "message": "tool routing failed (\(error.localizedDescription)); offering tools in order"])
            return .tools(specs)
        }
    }

    private func toolTokens(_ model: SystemLanguageModel, _ tools: [BuiltTool]) async -> Int {
        let definitions = tools.map {
            Transcript.ToolDefinition(name: $0.name, description: $0.description, parameters: $0.schema)
        }
        let instructions = Transcript.Entry.instructions(Transcript.Instructions(segments: [], toolDefinitions: definitions))
        let schemaCharacters = tools.reduce(0) { total, tool in total + tool.schema.debugDescription.count }
        return await tokenCount(model, [instructions], extraCharacters: schemaCharacters + 150 * tools.count)
    }

    private func lastPromptText(_ history: [[String: Any]]) -> String? {
        for item in history.reversed() where item["type"] as? String == "prompt" {
            if let text = item["text"] as? String, !text.isEmpty { return text }
        }
        return nil
    }

    /// Tool names from the newest tool calls back, without repeats.
    private func recentToolNames(_ history: [[String: Any]]) -> [String] {
        var names: [String] = []
        for item in history.reversed() where item["type"] as? String == "toolCalls" {
            for call in (item["calls"] as? [[String: Any]]) ?? [] {
                if let name = call["name"] as? String, !names.contains(name) { names.append(name) }
            }
        }
        return names
    }

    // MARK: - Context fitting

    private struct BuiltTool {
        let name: String
        let description: String
        let schema: GenerationSchema
    }

    private struct Fitted {
        let tools: [BuiltTool]
        let entries: [Transcript.Entry]
    }

    /// Instructions + tool definitions + history + prompt must leave the reply
    /// budget free. In order, until it fits: shorten tool descriptions, drop the
    /// oldest exchanges, then drop the last-registered tools.
    private func fit(model: SystemLanguageModel, system: String, tools specs: [ToolSpec],
                     history: [[String: Any]], prompt: String, maxTokens: Int) async -> Fitted {
        let contextSize = model.contextSize
        let reserve = min(maxTokens, contextSize / 3) + LanguageModelEngine.contextMargin
        var tools = buildTools(specs, compact: false)
        var past = transcriptEntries(history)
        let promptEntry = Transcript.Entry.prompt(Transcript.Prompt(segments: [.text(Transcript.TextSegment(content: prompt))]))

        func entries() -> [Transcript.Entry] {
            let definitions = tools.map {
                Transcript.ToolDefinition(name: $0.name, description: $0.description, parameters: $0.schema)
            }
            let instructions = Transcript.Instructions(segments: [.text(Transcript.TextSegment(content: system))],
                                                       toolDefinitions: definitions)
            return [.instructions(instructions)] + past
        }
        func overBudget() async -> Bool {
            // The tokenizer can't see tool schemas' size from a ToolDefinition; the fallback estimate adds them.
            let schemaCharacters = tools.reduce(0) { total, tool in total + tool.schema.debugDescription.count }
            let used = await tokenCount(model, entries() + [promptEntry], extraCharacters: schemaCharacters)
            return used + reserve > contextSize
        }

        if !tools.isEmpty, await overBudget() {
            tools = buildTools(specs, compact: true)
            send(["kind": "log", "message": "shortened tool descriptions to fit the context window"])
        }
        var droppedEntries = 0
        while !past.isEmpty, await overBudget() {
            // Drop the oldest exchange: through to the next user prompt.
            past.removeFirst()
            droppedEntries += 1
            while let first = past.first, !isPrompt(first) {
                past.removeFirst()
                droppedEntries += 1
            }
        }
        if droppedEntries > 0 {
            send(["kind": "log", "message": "dropped \(droppedEntries) history entries to fit the context window"])
        }
        var droppedTools: [String] = []
        while !tools.isEmpty, await overBudget() {
            droppedTools.append(tools.removeLast().name)
        }
        if !droppedTools.isEmpty {
            send(["kind": "log", "message": "dropped tools to fit the context window: \(droppedTools.joined(separator: ", "))"])
        }
        return Fitted(tools: tools, entries: entries())
    }

    private func tokenCount(_ model: SystemLanguageModel, _ entries: [Transcript.Entry], extraCharacters: Int) async -> Int {
        if #available(iOS 26.4, macOS 26.4, *) {
            if let count = try? await model.tokenCount(for: entries) { return count }
        }
        // Before iOS 26.4 there's no tokenizer API: estimate conservatively.
        var characters = extraCharacters
        for entry in entries { characters += estimateCharacters(entry) + 16 }
        return characters / 3
    }

    private func estimateCharacters(_ entry: Transcript.Entry) -> Int {
        func segments(_ list: [Transcript.Segment]) -> Int {
            list.reduce(0) { total, segment in
                switch segment {
                case .text(let text): return total + text.content.count
                case .structure(let structure): return total + structure.content.jsonString.count
                @unknown default: return total
                }
            }
        }
        switch entry {
        case .instructions(let instructions):
            var total = segments(instructions.segments)
            for definition in instructions.toolDefinitions {
                total += definition.name.count + definition.description.count
            }
            return total
        case .prompt(let prompt): return segments(prompt.segments)
        case .response(let response): return segments(response.segments)
        case .toolCalls(let calls): return calls.reduce(0) { $0 + $1.toolName.count + $1.arguments.jsonString.count }
        case .toolOutput(let output): return segments(output.segments)
        @unknown default: return 0
        }
    }

    private func isPrompt(_ entry: Transcript.Entry) -> Bool {
        if case .prompt = entry { return true }
        return false
    }

    // MARK: - Request conversion

    private func transcriptEntries(_ history: [[String: Any]]) -> [Transcript.Entry] {
        var entries: [Transcript.Entry] = []
        for item in history {
            let text = (item["text"] as? String) ?? ""
            switch item["type"] as? String {
            case "prompt":
                entries.append(.prompt(Transcript.Prompt(segments: [.text(Transcript.TextSegment(content: text))])))
            case "response":
                entries.append(.response(Transcript.Response(assetIDs: [], segments: [.text(Transcript.TextSegment(content: text))])))
            case "toolCalls":
                let calls: [Transcript.ToolCall] = ((item["calls"] as? [[String: Any]]) ?? []).compactMap { call in
                    guard let id = call["id"] as? String, let name = call["name"] as? String else { return nil }
                    let arguments = (try? GeneratedContent(json: (call["arguments"] as? String) ?? "{}"))
                        ?? GeneratedContent(properties: [:])
                    return Transcript.ToolCall(id: id, toolName: name, arguments: arguments)
                }
                if !calls.isEmpty { entries.append(.toolCalls(Transcript.ToolCalls(calls))) }
            case "toolOutput":
                guard let id = item["id"] as? String else { continue }
                entries.append(.toolOutput(Transcript.ToolOutput(
                    id: id, toolName: (item["name"] as? String) ?? "tool",
                    segments: [.text(Transcript.TextSegment(content: text))])))
            default:
                continue
            }
        }
        return entries
    }

    private func buildTools(_ specs: [ToolSpec], compact: Bool) -> [BuiltTool] {
        specs.map { spec in
            var builder = SchemaBuilder(compact: compact)
            let schema: GenerationSchema
            do {
                schema = try GenerationSchema(root: builder.object(spec.parameters, name: "\(spec.name)_arguments"),
                                              dependencies: [])
            } catch {
                send(["kind": "log", "message": "tool \(spec.name): unusable parameter schema (\(error)); offering it without parameters"])
                schema = (try? GenerationSchema(root: DynamicGenerationSchema(name: "\(spec.name)_arguments", properties: []),
                                                dependencies: []))
                    ?? GenerationSchema(type: GeneratedContent.self, properties: [])
            }
            let description = compact ? SchemaBuilder.shorten(spec.description, sentences: 1, limit: 160) : spec.description
            return BuiltTool(name: spec.name, description: description, schema: schema)
        }
    }

    // MARK: - Errors

    private func describe(_ error: Error) -> [String: Any] {
        if let error = error as? LanguageModelSession.GenerationError {
            switch error {
            case .exceededContextWindowSize:
                return failure("context", "That conversation is too long for the on-device model. Start a new conversation and try again.")
            case .assetsUnavailable:
                return failure("unavailable", "The Apple Intelligence model isn't available right now. Check that Apple Intelligence is on and finished downloading.")
            case .guardrailViolation, .refusal:
                return failure("refusal", "The on-device model declined this request.")
            case .unsupportedLanguageOrLocale:
                return failure("language", "The on-device model doesn't support this language.")
            case .rateLimited:
                return failure("rateLimited", "iOS is limiting the on-device model while Faceclaw is in the background. Try again in a moment, or with the phone unlocked.")
            case .concurrentRequests:
                return failure("busy", "The on-device model is busy with another request. Try again in a moment.")
            case .decodingFailure, .unsupportedGuide:
                return failure("other", "The on-device model produced an unreadable reply: \(error.localizedDescription)")
            @unknown default:
                return failure("other", "On-device model failed: \(error.localizedDescription)")
            }
        }
        if let error = error as? LanguageModelSession.ToolCallError {
            return failure("other", "On-device model tool call failed: \(error.underlyingError.localizedDescription)")
        }
        return failure("other", "On-device model failed: \(error.localizedDescription)")
    }

    private func failure(_ code: String, _ message: String) -> [String: Any] {
        ["kind": "error", "code": code, "message": message]
    }
}

/// JSON Schema (the subset our tool definitions use: objects of string, number,
/// integer, boolean, enum and array properties) to a DynamicGenerationSchema, so
/// the framework constrains tool arguments to valid values while decoding.
/// Anything it doesn't understand becomes a string rather than failing.
@available(iOS 26.0, *)
private struct SchemaBuilder {
    let compact: Bool
    private var names = Set<String>()

    init(compact: Bool) { self.compact = compact }

    mutating func object(_ json: [String: Any], name: String) -> DynamicGenerationSchema {
        let properties = (json["properties"] as? [String: Any]) ?? [:]
        let required = Set((json["required"] as? [String]) ?? [])
        // JSON objects lose declaration order; keep required properties first, then by name.
        let keys = properties.keys.sorted { a, b in
            let ra = required.contains(a), rb = required.contains(b)
            return ra != rb ? ra : a < b
        }
        let members: [DynamicGenerationSchema.Property] = keys.compactMap { key in
            guard let property = properties[key] as? [String: Any] else { return nil }
            return DynamicGenerationSchema.Property(
                name: key,
                description: describe(property),
                schema: value(property, name: "\(name)_\(key)"),
                isOptional: !required.contains(key))
        }
        return DynamicGenerationSchema(name: unique(name), description: nil, properties: members)
    }

    private mutating func value(_ json: [String: Any], name: String) -> DynamicGenerationSchema {
        if let choices = json["enum"] as? [Any], !choices.isEmpty {
            let strings = choices.compactMap { $0 as? String }
            if strings.count == choices.count {
                // A guide renders as one compact JSON Schema enum; an anyOf schema lists
                // every choice as its own subschema, at over twice the tokens.
                return DynamicGenerationSchema(type: String.self, guides: [.anyOf(strings)])
            }
        }
        switch schemaType(json) {
        case "integer":
            var guides: [GenerationGuide<Int>] = []
            if let minimum = (json["minimum"] as? NSNumber)?.intValue { guides.append(.minimum(minimum)) }
            if let maximum = (json["maximum"] as? NSNumber)?.intValue { guides.append(.maximum(maximum)) }
            return DynamicGenerationSchema(type: Int.self, guides: guides)
        case "number":
            var guides: [GenerationGuide<Double>] = []
            if let minimum = (json["minimum"] as? NSNumber)?.doubleValue { guides.append(.minimum(minimum)) }
            if let maximum = (json["maximum"] as? NSNumber)?.doubleValue { guides.append(.maximum(maximum)) }
            return DynamicGenerationSchema(type: Double.self, guides: guides)
        case "boolean":
            return DynamicGenerationSchema(type: Bool.self)
        case "array":
            let items = (json["items"] as? [String: Any]) ?? ["type": "string"]
            return DynamicGenerationSchema(arrayOf: value(items, name: "\(name)_item"),
                                           minimumElements: (json["minItems"] as? NSNumber)?.intValue,
                                           maximumElements: (json["maxItems"] as? NSNumber)?.intValue)
        case "object":
            return object(json, name: name)
        default:
            return DynamicGenerationSchema(type: String.self)
        }
    }

    private func schemaType(_ json: [String: Any]) -> String {
        if let type = json["type"] as? String { return type }
        if let types = json["type"] as? [String], let type = types.first(where: { $0 != "null" }) { return type }
        return json["properties"] != nil ? "object" : "string"
    }

    private func describe(_ json: [String: Any]) -> String? {
        guard let text = json["description"] as? String, !text.isEmpty else { return nil }
        return compact ? SchemaBuilder.shorten(text, sentences: 1, limit: 80) : text
    }

    /// Schema names must be unique within one GenerationSchema.
    private mutating func unique(_ base: String) -> String {
        var name = base
        var suffix = 2
        while names.contains(name) {
            name = "\(base)_\(suffix)"
            suffix += 1
        }
        names.insert(name)
        return name
    }

    /// The first `sentences` sentences, cut to `limit` characters.
    static func shorten(_ text: String, sentences: Int, limit: Int) -> String {
        var result = ""
        var count = 0
        var remainder = Substring(text)
        while count < sentences, !remainder.isEmpty {
            if let end = remainder.range(of: ". ") {
                result += remainder[..<end.lowerBound] + "."
                remainder = remainder[end.upperBound...]
                if count + 1 < sentences { result += " " }
            } else {
                result += remainder
                remainder = ""
            }
            count += 1
        }
        if result.count > limit { result = String(result.prefix(limit - 1)) + "…" }
        return result
    }
}

#endif
