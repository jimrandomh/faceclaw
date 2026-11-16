#import "FaceclawSsh.h"
#import <Faceclawssh/Faceclawssh.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>

static NSString *const kClientKeyTag = @"com.faceclaw.ssh.client";
static NSString *const kSecretService = @"com.faceclaw.ssh.secret";

#pragma mark - Client key

static NSData *ClientKeyTagData(void) {
    return [kClientKeyTag dataUsingEncoding:NSUTF8StringEncoding];
}

static SecKeyRef CopyClientKey(void) {
    NSDictionary *query = @{
        (id)kSecClass: (id)kSecClassKey,
        (id)kSecAttrApplicationTag: ClientKeyTagData(),
        (id)kSecAttrKeyType: (id)kSecAttrKeyTypeECSECPrimeRandom,
        (id)kSecReturnRef: @YES,
    };
    CFTypeRef key = NULL;
    if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &key) != errSecSuccess) return NULL;
    return (SecKeyRef)key;
}

static SecKeyRef CreateClientKey(BOOL secureEnclave) {
    SecAccessControlRef access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        secureEnclave ? kSecAccessControlPrivateKeyUsage : 0, NULL);
    if (!access) return NULL;
    NSMutableDictionary *attributes = [@{
        (id)kSecAttrKeyType: (id)kSecAttrKeyTypeECSECPrimeRandom,
        (id)kSecAttrKeySizeInBits: @256,
        (id)kSecPrivateKeyAttrs: @{
            (id)kSecAttrIsPermanent: @YES,
            (id)kSecAttrApplicationTag: ClientKeyTagData(),
            (id)kSecAttrAccessControl: (__bridge id)access,
        },
    } mutableCopy];
    if (secureEnclave) attributes[(id)kSecAttrTokenID] = (id)kSecAttrTokenIDSecureEnclave;
    CFErrorRef error = NULL;
    SecKeyRef key = SecKeyCreateRandomKey((__bridge CFDictionaryRef)attributes, &error);
    CFRelease(access);
    if (!key && error) {
        NSLog(@"FaceclawSsh: key generation failed (secure enclave %d): %@", secureEnclave, (__bridge NSError *)error);
        CFRelease(error);
    }
    return key;
}

/** The client key, generating it on first use. Caller releases. */
static SecKeyRef CopyOrCreateClientKey(void) {
    @synchronized([FaceclawSshKeys class]) {
        SecKeyRef key = CopyClientKey();
        if (key) return key;
        key = CreateClientKey(YES);
#if TARGET_OS_SIMULATOR
        if (!key) key = CreateClientKey(NO);
#endif
        return key;
    }
}

/** Uncompressed X9.62 public point (0x04 || X || Y). */
static NSData *PublicKeyData(SecKeyRef key) {
    SecKeyRef publicKey = SecKeyCopyPublicKey(key);
    if (!publicKey) return nil;
    NSData *data = (__bridge_transfer NSData *)SecKeyCopyExternalRepresentation(publicKey, NULL);
    CFRelease(publicKey);
    return data;
}

@interface FaceclawSshSigner : NSObject <FaceclawsshSigner>
@end

@implementation FaceclawSshSigner {
    SecKeyRef _key;
    NSData *_publicKey;
}
- (instancetype)initWithKey:(SecKeyRef)key {
    if ((self = [super init])) {
        _key = (SecKeyRef)CFRetain(key);
        _publicKey = PublicKeyData(key);
    }
    return self;
}
- (void)dealloc {
    if (_key) CFRelease(_key);
}
- (NSData *)publicKey {
    return _publicKey;
}
- (NSData *)sign:(NSData *)data error:(NSError **)error {
    CFErrorRef cfError = NULL;
    NSData *signature = (__bridge_transfer NSData *)SecKeyCreateSignature(
        _key, kSecKeyAlgorithmECDSASignatureMessageX962SHA256, (__bridge CFDataRef)(data ?: [NSData data]), &cfError);
    if (!signature) {
        if (error) *error = (__bridge_transfer NSError *)cfError;
        else if (cfError) CFRelease(cfError);
    }
    return signature;
}
@end

#pragma mark - Channel

@interface FaceclawSshEventQueue : NSObject <FaceclawsshListener>
@property(nonatomic, strong) NSMutableArray *events;
@property(nonatomic) BOOL ended;
@end

@implementation FaceclawSshEventQueue
- (instancetype)init {
    if ((self = [super init])) _events = [NSMutableArray array];
    return self;
}
- (void)onEvent:(NSString *)kind payload:(NSString *)payload {
    @synchronized(self) {
        if (_ended) return;
        [_events addObject:@{@"kind": kind ?: @"", @"payload": payload ?: @""}];
    }
}
@end

@implementation FaceclawSshChannel {
    FaceclawsshChannel *_channel;
    FaceclawSshEventQueue *_queue;
}

- (instancetype)initWithSpec:(NSString *)spec useKey:(BOOL)useKey {
    if ((self = [super init])) {
        _queue = [FaceclawSshEventQueue new];
        FaceclawSshSigner *signer = nil;
        if (useKey) {
            SecKeyRef key = CopyOrCreateClientKey();
            if (key) {
                signer = [[FaceclawSshSigner alloc] initWithKey:key];
                CFRelease(key);
            }
        }
        _channel = FaceclawsshOpen(spec, signer, _queue);
    }
    return self;
}

- (NSString *)takeEvents {
    NSArray *events;
    @synchronized(_queue) {
        if (_queue.events.count == 0) return @"[]";
        events = [_queue.events copy];
        [_queue.events removeAllObjects];
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:events options:0 error:nil];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"[]";
}

- (BOOL)send:(NSString *)text {
    return [_channel send:text];
}

- (void)close {
    @synchronized(_queue) {
        _queue.ended = YES;
        [_queue.events removeAllObjects];
    }
    [_channel close];
}
@end

#pragma mark - Keys and secrets

@implementation FaceclawSshKeys

+ (NSString *)authorizedKeyWithComment:(NSString *)comment {
    SecKeyRef key = CopyOrCreateClientKey();
    if (!key) return nil;
    NSData *publicKey = PublicKeyData(key);
    CFRelease(key);
    NSError *error = nil;
    NSString *line = FaceclawsshAuthorizedKey(publicKey, comment ?: @"", &error);
    if (error) NSLog(@"FaceclawSsh: authorizedKey failed: %@", error);
    return line;
}

+ (NSString *)fingerprint {
    SecKeyRef key = CopyOrCreateClientKey();
    if (!key) return nil;
    NSData *publicKey = PublicKeyData(key);
    CFRelease(key);
    NSError *error = nil;
    NSString *fingerprint = FaceclawsshFingerprint(publicKey, &error);
    if (error) NSLog(@"FaceclawSsh: fingerprint failed: %@", error);
    return fingerprint;
}

+ (NSDictionary *)secretQuery:(NSString *)secretId {
    return @{
        (id)kSecClass: (id)kSecClassGenericPassword,
        (id)kSecAttrService: kSecretService,
        (id)kSecAttrAccount: secretId ?: @"",
    };
}

+ (void)setSecret:(NSString *)value forId:(NSString *)secretId {
    NSDictionary *query = [self secretQuery:secretId];
    SecItemDelete((__bridge CFDictionaryRef)query);
    NSMutableDictionary *item = [query mutableCopy];
    item[(id)kSecValueData] = [(value ?: @"") dataUsingEncoding:NSUTF8StringEncoding];
    item[(id)kSecAttrAccessible] = (id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
    OSStatus status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
    if (status != errSecSuccess) NSLog(@"FaceclawSsh: saving secret failed: %d", (int)status);
}

+ (NSString *)secretForId:(NSString *)secretId {
    NSMutableDictionary *query = [[self secretQuery:secretId] mutableCopy];
    query[(id)kSecReturnData] = @YES;
    query[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
    CFTypeRef result = NULL;
    if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &result) != errSecSuccess) return @"";
    NSData *data = (__bridge_transfer NSData *)result;
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
}

+ (void)removeSecretForId:(NSString *)secretId {
    SecItemDelete((__bridge CFDictionaryRef)[self secretQuery:secretId]);
}

+ (void)copyToClipboard:(NSString *)text {
    dispatch_async(dispatch_get_main_queue(), ^{
        UIPasteboard.generalPasteboard.string = text ?: @"";
    });
}
@end
