#import <Foundation/Foundation.h>

/** Process-wide store: serializes all isolates and commits JSONC atomically. */
@interface FaceclawSettings : NSObject
+ (instancetype)shared;
- (instancetype)initWithDirectory:(NSString *)directory defaults:(NSUserDefaults *)defaults domain:(NSString *)domain;
- (NSString *)getString:(NSString *)key fallback:(NSString *)fallback;
- (BOOL)getBoolean:(NSString *)key fallback:(BOOL)fallback;
- (void)setString:(NSString *)key value:(NSString *)value;
- (void)setBoolean:(NSString *)key value:(BOOL)value;
- (double)getNumber:(NSString *)key fallback:(double)fallback;
- (void)setNumber:(NSString *)key value:(double)value;
- (void)remove:(NSString *)key;
- (NSString *)changeToken;
- (NSString *)exportConfig;
- (BOOL)importConfig:(NSString *)text merge:(BOOL)merge error:(NSError **)error;
@end
