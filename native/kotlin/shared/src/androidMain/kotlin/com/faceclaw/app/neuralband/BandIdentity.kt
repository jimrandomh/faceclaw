// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/BandIdentity.swift,
// by way of tetramo-labs/glassly (MIT). The keystore-backed store is Android-only and lives in
// App_Resources (FaceclawNeuralBandStores.kt); the recovered-record importer is not carried over.
package com.faceclaw.app.neuralband

/**
 * The identity used to prove band ownership on an enrolled band. The private
 * key signs the host `EnableTrust` proof. When the optional band key is
 * present, the band's `EnableTrustEC` proof is verified before it is
 * acknowledged.
 */
class BandEnrollmentIdentity(
    val privateKey: P256.Signing.PrivateKey,
    val bandPublicKey: P256.Signing.PublicKey? = null,
)

/**
 * The band answered an identity result that rejects our stored key. The
 * connection surfaces the message and claims the band again on its next attempt.
 */
class BandIdentityMismatchError(override val message: String) : Exception(message)

/** One stored identity per band. Key bytes never appear in logs. */
interface BandIdentityStore {
    fun load(bandId: String): BandEnrollmentIdentity?

    /** Leaves a previously stored band key in place when [bandKey] is null. */
    fun save(bandId: String, privateKey: P256.Signing.PrivateKey, bandKey: P256.Signing.PublicKey?)

    fun delete(bandId: String)
}
