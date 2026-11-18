#import <Foundation/Foundation.h>

/**
 * One SSH channel for the TypeScript side (app/native/ssh.ios.ts), backed by
 * the gomobile-bound Go transport in native/ssh. `spec` is the Go openSpec
 * JSON. Events arrive on Go threads and queue here; the owning JS isolate
 * drains them with takeEvents (a JSON array of {kind, payload}).
 */
@interface FaceclawSshChannel : NSObject
- (instancetype)initWithSpec:(NSString *)spec useKey:(BOOL)useKey;
- (NSString *)takeEvents;
- (BOOL)send:(NSString *)text;
- (void)close;
@end

/**
 * The device's SSH client key (a non-exportable Secure Enclave P-256 key; a
 * plain keychain key on the simulator, which has no Secure Enclave) and the
 * Terminal app's saved SSH passwords (keychain generic passwords).
 */
@interface FaceclawSshKeys : NSObject
/** "ecdsa-sha2-nistp256 AAAA... comment"; generates the key if needed. nil on failure. */
+ (NSString *)authorizedKeyWithComment:(NSString *)comment;
/** "SHA256:..." fingerprint; generates the key if needed. nil on failure. */
+ (NSString *)fingerprint;
+ (void)setSecret:(NSString *)value forId:(NSString *)secretId;
/** The saved secret, or "" if none. */
+ (NSString *)secretForId:(NSString *)secretId;
+ (void)removeSecretForId:(NSString *)secretId;
+ (void)copyToClipboard:(NSString *)text;
@end
