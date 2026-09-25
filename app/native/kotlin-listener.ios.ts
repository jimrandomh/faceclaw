/**
 * Implements a FaceclawKit (Kotlin) listener protocol with plain JavaScript methods.
 * NativeScript maps the method names to the protocol's selectors by camel-casing the
 * selector parts (`onLog:` -> `onLogLine`, `onState:detail:` -> `onStateStateDetail`, ...).
 * Keep a reference to the returned object for as long as the Kotlin side may call it.
 */
export function kotlinListener<T extends object>(protocol: unknown, methods: T): T {
  const NativeListener = (NSObject as any).extend(methods, { protocols: [protocol] })
  return NativeListener.new() as T
}
