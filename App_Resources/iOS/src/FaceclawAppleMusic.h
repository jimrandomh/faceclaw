#import <Foundation/Foundation.h>

/**
 * Apple Music (the system Music app) through the MediaPlayer framework: now-playing state
 * and transport on the system player, the media library as a browse tree, and the system
 * output volume. Call from the main thread; callbacks are delivered on the main queue.
 * Nothing touches the player or library until media-library access is granted, so no
 * permission prompt appears unasked.
 */
@interface FaceclawAppleMusic : NSObject
+ (instancetype)shared;
/** Playback state, the now-playing item or authorization may have changed. */
@property(nonatomic, copy) void (^changeHandler)(void);
- (BOOL)hasPermission;
- (NSString *)permissionStatus;
- (void)requestPermission:(void (^)(BOOL granted))completion;
/** Observe the system player (and keep observing across authorization changes). */
- (void)start;
- (void)stop;
/** The system player as a JSON object; {"access": false} until access is granted. */
- (NSString *)stateJson;
- (void)playPause;
- (void)skipNext;
- (void)skipPrevious;
/**
 * The queue Faceclaw last started, as [{"id", "title", "active"}], while the player is
 * still playing from it; "[]" otherwise (the system player does not expose queues that
 * the Music app started).
 */
- (NSString *)queueJson;
- (void)skipToQueueIndex:(NSInteger)index;
/** [widthLo, widthHi, heightLo, heightHi, BGRA...] fitted within maxSize (never upscaled), or nil. */
- (NSData *)albumArt:(NSInteger)maxSize;
/** System output volume 0..100, or -1 when unknown. */
- (double)volumePercent;
- (void)setVolumePercent:(double)percent;
/** One level of the library tree ("root" first) as [{"mediaId", "title", "subtitle", "browsable", "playable"}]. */
- (void)browse:(NSString *)parentId completion:(void (^)(NSString *json, NSString *error))completion;
/** Start playback of a browsed collection, or of a song within its collection. */
- (void)play:(NSString *)mediaId completion:(void (^)(NSString *error))completion;
@end
