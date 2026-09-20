#import "FaceclawSettings.h"
#import <FaceclawKit/FaceclawKit.h>

@implementation FaceclawSettings {
    NSString *_path;
    NSString *_token;
    FaceclawKitSettingsDocument *_document;
}
+ (instancetype)shared {
    static FaceclawSettings *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *library = NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES).firstObject;
        instance = [[self alloc] initWithDirectory:library defaults:NSUserDefaults.standardUserDefaults domain:NSBundle.mainBundle.bundleIdentifier];
    });
    return instance;
}
- (instancetype)initWithDirectory:(NSString *)directory defaults:(NSUserDefaults *)defaults domain:(NSString *)domain {
    if ((self = [super init])) {
        _path = [directory stringByAppendingPathComponent:@"faceclaw_settings.jsonc"];
        _token = NSUUID.UUID.UUIDString;
        FaceclawKitSettingsCodec *codec = [FaceclawKitSettingsCodec new];
        NSError *error = nil;
        BOOL exists = [NSFileManager.defaultManager fileExistsAtPath:_path];
        NSString *text;
        if (exists) text = [NSString stringWithContentsOfFile:_path encoding:NSUTF8StringEncoding error:&error];
        else {
            // Migrate the persistent app domain only, never registered/system defaults.
            [defaults synchronize];
            NSMutableDictionary *legacy = [NSMutableDictionary new];
            NSDictionary *before = [defaults persistentDomainForName:domain] ?: @{};
            for (NSString *key in before) {
                id value = before[key];
                if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class]) legacy[key] = value;
            }
            [legacy removeObjectForKey:@"ios.settings.changeToken"];
            NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"schema":@1, @"settings":legacy} options:0 error:&error];
            text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
        }
        _document = text ? [codec decodeText:text] : nil;
        if (!_document) [NSException raise:@"FaceclawSettings" format:@"Invalid or unsupported config; original retained (%@)", error ?: @"schema/JSONC validation failed"];
        if (!exists || [codec needsMigrationText:text]) {
            if (![self persist:_document error:&error]) [NSException raise:@"FaceclawSettings" format:@"Could not migrate config: %@", error];
        }
    }
    return self;
}
- (BOOL)persist:(FaceclawKitSettingsDocument *)next error:(NSError **)error {
    NSString *encoded = [next encodeForStorage];
    if (!encoded) {
        if (error) *error = [NSError errorWithDomain:@"FaceclawSettings" code:2 userInfo:@{NSLocalizedDescriptionKey:@"Settings exceed format limits"}];
        return NO;
    }
    NSData *data = [encoded dataUsingEncoding:NSUTF8StringEncoding];
    if (![data writeToFile:_path options:NSDataWritingAtomic error:error]) return NO;
    _document = next;
    _token = NSUUID.UUID.UUIDString;
    return YES;
}
- (NSString *)getString:(NSString *)key fallback:(NSString *)fallback {
    @synchronized(self) { return [_document getStringKey:key fallback:fallback]; }
}
- (BOOL)getBoolean:(NSString *)key fallback:(BOOL)fallback {
    @synchronized(self) { return [_document getBooleanKey:key fallback:fallback]; }
}
- (void)setString:(NSString *)key value:(NSString *)value {
    @synchronized(self) {
        if ([_document containsStringKey:key value:value]) return;
        NSError *error = nil;
        if (![self persist:[_document replacingStringKey:key value:value] error:&error])
            [NSException raise:@"FaceclawSettings" format:@"Could not save settings: %@", error];
    }
}
- (void)setBoolean:(NSString *)key value:(BOOL)value {
    @synchronized(self) {
        if ([_document getBooleanKey:key fallback:!value] == value) return;
        NSError *error = nil;
        if (![self persist:[_document replacingBooleanKey:key value:value] error:&error])
            [NSException raise:@"FaceclawSettings" format:@"Could not save settings: %@", error];
    }
}
- (double)getNumber:(NSString *)key fallback:(double)fallback {
    @synchronized(self) { return [_document getNumberKey:key fallback:fallback]; }
}
- (void)setNumber:(NSString *)key value:(double)value {
    if (!isfinite(value)) [NSException raise:@"FaceclawSettings" format:@"Non-finite setting"];
    @synchronized(self) {
        NSError *error = nil;
        if (![self persist:[_document replacingNumberKey:key value:value] error:&error])
            [NSException raise:@"FaceclawSettings" format:@"Could not save settings: %@", error];
    }
}
- (void)remove:(NSString *)key {
    @synchronized(self) {
        NSError *error = nil;
        if (![self persist:[_document removingKey:key] error:&error])
            [NSException raise:@"FaceclawSettings" format:@"Could not save settings: %@", error];
    }
}
- (NSString *)changeToken { @synchronized(self) { return _token; } }
- (NSString *)exportConfig { @synchronized(self) { return [_document encode]; } }
- (BOOL)importConfig:(NSString *)text merge:(BOOL)merge error:(NSError **)error {
    @synchronized(self) {
        FaceclawKitSettingsDocument *next = [[FaceclawKitSettingsCodec new] decodeText:text];
        if (!next) {
            if (error) *error = [NSError errorWithDomain:@"FaceclawSettings" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Invalid or unsupported config"}];
            return NO;
        }
        NSData *previous = [NSData dataWithContentsOfFile:_path options:0 error:error];
        if (!previous || ![previous writeToFile:[_path stringByAppendingString:@".previous"] options:NSDataWritingAtomic error:error]) return NO;
        return [self persist:merge ? [_document mergedOther:next] : next error:error];
    }
}
@end
