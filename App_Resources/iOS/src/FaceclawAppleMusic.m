#import "FaceclawAppleMusic.h"
#import "FaceclawGraphics.h"
#import <AVFoundation/AVFoundation.h>
#import <MediaPlayer/MediaPlayer.h>
#import <UIKit/UIKit.h>
#import <errno.h>
#import <math.h>
#import <stdlib.h>

/** How long a queue Faceclaw just set may take to become the player's now-playing context. */
static const NSTimeInterval kQueueConfirmSeconds = 5.0;

static NSString *JsonString(id object, NSString *fallback) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : fallback;
}

/** Persistent IDs are unsigned 64-bit, beyond JavaScript's exact integers, so they cross as decimal strings. */
static NSString *IdString(MPMediaEntityPersistentID persistentId) {
    return [NSString stringWithFormat:@"%llu", persistentId];
}

static BOOL ParseId(NSString *text, MPMediaEntityPersistentID *out) {
    const char *chars = text.UTF8String;
    if (!chars || chars[0] < '0' || chars[0] > '9') return NO;
    char *end = NULL;
    errno = 0;
    unsigned long long value = strtoull(chars, &end, 10);
    if (errno || !end || *end) return NO;
    *out = value;
    return YES;
}

static NSDictionary *BrowseRow(NSString *mediaId, NSString *title, NSString *subtitle, BOOL browsable, BOOL playable) {
    return @{@"mediaId": mediaId, @"title": title ?: @"", @"subtitle": subtitle ?: @"",
             @"browsable": @(browsable), @"playable": @(playable)};
}

@interface FaceclawAppleMusic ()
@property(nonatomic, strong) dispatch_queue_t libraryQueue;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL observing;
/** Bumped whenever the now-playing item changes, so cached album art is refetched. */
@property(nonatomic) NSInteger artVersion;
@property(nonatomic, copy) NSString *nowPlayingKey;
/** The items of the queue Faceclaw last started, until the player leaves them. */
@property(nonatomic, copy) NSArray<MPMediaItem *> *queueItems;
@property(nonatomic) BOOL queueConfirmed;
@property(nonatomic, strong) NSDate *queueSetAt;
@property(nonatomic, strong) MPVolumeView *volumeView;
@end

@implementation FaceclawAppleMusic
+ (instancetype)shared {
    static FaceclawAppleMusic *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ instance = [FaceclawAppleMusic new]; });
    return instance;
}

- (instancetype)init {
    if ((self = [super init])) {
        _libraryQueue = dispatch_queue_create("com.faceclaw.applemusic", DISPATCH_QUEUE_SERIAL);
        _nowPlayingKey = @"";
        // Access may have been granted or revoked in Settings while away.
        [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(appBecameActive:)
            name:UIApplicationDidBecomeActiveNotification object:nil];
    }
    return self;
}

#pragma mark - Authorization

- (BOOL)hasPermission {
    return MPMediaLibrary.authorizationStatus == MPMediaLibraryAuthorizationStatusAuthorized;
}

- (NSString *)permissionStatus {
    switch (MPMediaLibrary.authorizationStatus) {
        case MPMediaLibraryAuthorizationStatusAuthorized: return @"granted";
        case MPMediaLibraryAuthorizationStatusDenied: return @"denied";
        case MPMediaLibraryAuthorizationStatusRestricted: return @"restricted";
        default: return @"not-determined";
    }
}

- (void)requestPermission:(void (^)(BOOL))completion {
    if ([self hasPermission]) {
        completion(YES);
        return;
    }
    [MPMediaLibrary requestAuthorization:^(MPMediaLibraryAuthorizationStatus status) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self syncObserving];
            [self notifyChanged];
            completion(status == MPMediaLibraryAuthorizationStatusAuthorized);
        });
    }];
}

- (void)appBecameActive:(NSNotification *)notification {
    [self syncObserving];
    [self notifyChanged];
}

#pragma mark - Observation

- (void)start {
    self.started = YES;
    [self syncObserving];
}

- (void)stop {
    self.started = NO;
    [self syncObserving];
}

- (void)syncObserving {
    BOOL want = self.started && [self hasPermission];
    if (want == self.observing) return;
    self.observing = want;
    MPMusicPlayerController *player = MPMusicPlayerController.systemMusicPlayer;
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    if (want) {
        [center addObserver:self selector:@selector(playbackStateChanged:)
            name:MPMusicPlayerControllerPlaybackStateDidChangeNotification object:player];
        [center addObserver:self selector:@selector(nowPlayingItemChanged:)
            name:MPMusicPlayerControllerNowPlayingItemDidChangeNotification object:player];
        [player beginGeneratingPlaybackNotifications];
    } else {
        [center removeObserver:self name:MPMusicPlayerControllerPlaybackStateDidChangeNotification object:player];
        [center removeObserver:self name:MPMusicPlayerControllerNowPlayingItemDidChangeNotification object:player];
        [player endGeneratingPlaybackNotifications];
    }
}

- (void)playbackStateChanged:(NSNotification *)notification {
    [self notifyChanged];
}

- (void)nowPlayingItemChanged:(NSNotification *)notification {
    // Streamed catalog items can share identity fields, so every change counts.
    self.artVersion++;
    [self notifyChanged];
}

- (void)notifyChanged {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.changeHandler) self.changeHandler();
    });
}

#pragma mark - Now playing

- (NSString *)stateJson {
    if (![self hasPermission]) return @"{\"access\":false}";
    MPMusicPlayerController *player = MPMusicPlayerController.systemMusicPlayer;
    MPMediaItem *item = player.nowPlayingItem;
    NSString *key = item ? [NSString stringWithFormat:@"%llu|%@|%@|%@", item.persistentID,
        item.playbackStoreID ?: @"", item.title ?: @"", item.artist ?: @""] : @"";
    if (![key isEqualToString:self.nowPlayingKey]) {
        self.nowPlayingKey = key;
        self.artVersion++;
    }
    NSString *state;
    switch (player.playbackState) {
        case MPMusicPlaybackStatePlaying:
        case MPMusicPlaybackStateSeekingForward:
        case MPMusicPlaybackStateSeekingBackward:
            state = @"playing";
            break;
        case MPMusicPlaybackStatePaused:
        case MPMusicPlaybackStateInterrupted:
            state = @"paused";
            break;
        default:
            state = @"stopped";
            break;
    }
    NSTimeInterval position = player.currentPlaybackTime;
    NSTimeInterval duration = item.playbackDuration;
    float rate = player.currentPlaybackRate;
    return JsonString(@{
        @"access": @YES,
        @"hasItem": @(item != nil),
        @"state": state,
        @"title": item.title ?: @"",
        @"artist": item.artist ?: @"",
        @"album": item.albumTitle ?: @"",
        @"positionMs": @(item && isfinite(position) && position >= 0 ? position * 1000.0 : -1),
        @"durationMs": @(item && isfinite(duration) && duration > 0 ? duration * 1000.0 : -1),
        @"rate": @(isfinite(rate) ? rate : 0),
        @"artVersion": @(self.artVersion),
    }, @"{\"access\":true}");
}

- (void)playPause {
    if (![self hasPermission]) return;
    MPMusicPlayerController *player = MPMusicPlayerController.systemMusicPlayer;
    switch (player.playbackState) {
        case MPMusicPlaybackStatePlaying:
        case MPMusicPlaybackStateSeekingForward:
        case MPMusicPlaybackStateSeekingBackward:
            [player pause];
            break;
        default:
            [player play];
            break;
    }
}

- (void)skipNext {
    if ([self hasPermission]) [MPMusicPlayerController.systemMusicPlayer skipToNextItem];
}

- (void)skipPrevious {
    if ([self hasPermission]) [MPMusicPlayerController.systemMusicPlayer skipToPreviousItem];
}

- (NSData *)albumArt:(NSInteger)maxSize {
    if (maxSize <= 0 || maxSize > 1024 || ![self hasPermission]) return nil;
    MPMediaItemArtwork *artwork = MPMusicPlayerController.systemMusicPlayer.nowPlayingItem.artwork;
    return [FaceclawGraphics bgraPacket:[artwork imageWithSize:CGSizeMake(maxSize, maxSize)].CGImage maxSize:maxSize];
}

#pragma mark - Queue

/** Index of the now-playing item in Faceclaw's queue; forgets the queue once the player has left it. */
- (NSInteger)activeQueueIndex {
    NSArray<MPMediaItem *> *items = self.queueItems;
    if (!items.count || ![self hasPermission]) return -1;
    MPMusicPlayerController *player = MPMusicPlayerController.systemMusicPlayer;
    MPMediaItem *now = player.nowPlayingItem;
    NSInteger found = -1;
    if (now) {
        NSUInteger index = player.indexOfNowPlayingItem;
        if (index < items.count && items[index].persistentID == now.persistentID) {
            found = (NSInteger)index;
        } else {
            for (NSUInteger i = 0; i < items.count; i++) {
                if (items[i].persistentID == now.persistentID) { found = (NSInteger)i; break; }
            }
        }
    }
    if (found >= 0) {
        self.queueConfirmed = YES;
        return found;
    }
    // Either the player hasn't switched over yet, or it has moved on to another queue.
    if (self.queueConfirmed || -[self.queueSetAt timeIntervalSinceNow] > kQueueConfirmSeconds) {
        self.queueItems = nil;
    }
    return -1;
}

- (NSString *)queueJson {
    NSInteger active = [self activeQueueIndex];
    if (active < 0) return @"[]";
    NSMutableArray *rows = [NSMutableArray arrayWithCapacity:self.queueItems.count];
    [self.queueItems enumerateObjectsUsingBlock:^(MPMediaItem *item, NSUInteger index, BOOL *stop) {
        [rows addObject:@{@"id": @(index), @"title": item.title ?: @"", @"active": @((NSInteger)index == active)}];
    }];
    return JsonString(rows, @"[]");
}

- (void)skipToQueueIndex:(NSInteger)index {
    if ([self activeQueueIndex] < 0 || index < 0 || index >= (NSInteger)self.queueItems.count) return;
    MPMusicPlayerController *player = MPMusicPlayerController.systemMusicPlayer;
    player.nowPlayingItem = self.queueItems[index];
    [player play];
}

#pragma mark - Volume

- (UIWindow *)hostWindow {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        NSArray<UIWindow *> *windows = ((UIWindowScene *)scene).windows;
        for (UIWindow *window in windows) if (window.isKeyWindow) return window;
        if (windows.firstObject) return windows.firstObject;
    }
    return nil;
}

/**
 * The slider of an off-screen MPVolumeView: iOS has no public setter for the system volume,
 * but the volume view's slider drives it while the view is in a window.
 */
- (UISlider *)volumeSlider:(BOOL *)attached {
    if (!self.volumeView) {
        self.volumeView = [[MPVolumeView alloc] initWithFrame:CGRectMake(-2000, -2000, 160, 40)];
    }
    if (!self.volumeView.window) {
        UIWindow *window = [self hostWindow];
        if (!window) return nil;
        [window addSubview:self.volumeView];
        if (attached) *attached = YES;
    }
    for (UIView *view in self.volumeView.subviews) {
        if ([view isKindOfClass:UISlider.class]) return (UISlider *)view;
    }
    return nil;
}

- (double)volumePercent {
    // The slider tracks the system volume once attached; until then (nothing has been set
    // yet) the session's reading, which can lag while Faceclaw's audio session is inactive.
    UISlider *slider = self.volumeView.window ? [self volumeSlider:NULL] : nil;
    float volume = slider ? slider.value : AVAudioSession.sharedInstance.outputVolume;
    return isfinite(volume) ? MAX(0.0, MIN(100.0, round(volume * 100.0))) : -1;
}

- (void)setVolumePercent:(double)percent {
    if (!isfinite(percent)) return;
    BOOL attached = NO;
    UISlider *slider = [self volumeSlider:&attached];
    if (!slider) return;
    float value = (float)MAX(0.0, MIN(1.0, percent / 100.0));
    void (^apply)(void) = ^{
        [slider setValue:value animated:NO];
        [slider sendActionsForControlEvents:UIControlEventValueChanged];
    };
    // A freshly attached volume view ignores changes until it has wired up its slider.
    if (attached) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.15 * NSEC_PER_SEC)), dispatch_get_main_queue(), apply);
    else apply();
}

#pragma mark - Library

/**
 * Songs of a playable collection id: "playlist:<id>", "album:<id>", "artist:<id>" (album by
 * album, in track order) or "songs" (the whole library). Runs on the library queue.
 */
- (NSArray<MPMediaItem *> *)itemsForCollection:(NSString *)collectionId {
    if ([collectionId isEqualToString:@"songs"]) return [MPMediaQuery songsQuery].items ?: @[];
    NSRange colon = [collectionId rangeOfString:@":"];
    MPMediaEntityPersistentID persistentId;
    if (colon.location == NSNotFound || !ParseId([collectionId substringFromIndex:colon.location + 1], &persistentId)) return @[];
    NSString *kind = [collectionId substringToIndex:colon.location];
    MPMediaQuery *query;
    NSString *property;
    if ([kind isEqualToString:@"playlist"]) {
        query = [MPMediaQuery playlistsQuery];
        property = MPMediaPlaylistPropertyPersistentID;
    } else if ([kind isEqualToString:@"album"]) {
        query = [MPMediaQuery albumsQuery];
        property = MPMediaItemPropertyAlbumPersistentID;
    } else if ([kind isEqualToString:@"artist"]) {
        query = [MPMediaQuery albumsQuery];
        property = MPMediaItemPropertyArtistPersistentID;
    } else {
        return @[];
    }
    [query addFilterPredicate:[MPMediaPropertyPredicate predicateWithValue:@(persistentId) forProperty:property]];
    NSMutableArray<MPMediaItem *> *items = [NSMutableArray new];
    for (MPMediaItemCollection *collection in query.collections) [items addObjectsFromArray:collection.items];
    return items;
}

- (NSArray *)songRows:(NSArray<MPMediaItem *> *)items context:(NSString *)collectionId {
    NSMutableArray *rows = [NSMutableArray arrayWithCapacity:items.count];
    for (MPMediaItem *item in items) {
        [rows addObject:BrowseRow([NSString stringWithFormat:@"song:%@@%@", IdString(item.persistentID), collectionId],
            item.title, item.artist, NO, YES)];
    }
    return rows;
}

- (NSArray *)albumRows:(MPMediaQuery *)query {
    NSMutableArray *rows = [NSMutableArray new];
    for (MPMediaItemCollection *album in query.collections) {
        MPMediaItem *item = album.representativeItem;
        if (!item) continue;
        [rows addObject:BrowseRow([@"album:" stringByAppendingString:IdString(item.albumPersistentID)],
            item.albumTitle, item.albumArtist.length ? item.albumArtist : item.artist, YES, YES)];
    }
    return rows;
}

- (NSArray *)childrenOf:(NSString *)parentId {
    if ([parentId isEqualToString:@"root"]) {
        return @[BrowseRow(@"playlists", @"Playlists", nil, YES, NO), BrowseRow(@"artists", @"Artists", nil, YES, NO),
                 BrowseRow(@"albums", @"Albums", nil, YES, NO), BrowseRow(@"songs", @"Songs", nil, YES, NO)];
    }
    if ([parentId isEqualToString:@"playlists"]) {
        NSMutableArray *rows = [NSMutableArray new];
        for (MPMediaPlaylist *playlist in [MPMediaQuery playlistsQuery].collections) {
            NSUInteger count = playlist.count;
            NSString *subtitle = count == 1 ? @"1 song" : [NSString stringWithFormat:@"%lu songs", (unsigned long)count];
            [rows addObject:BrowseRow([@"playlist:" stringByAppendingString:IdString(playlist.persistentID)],
                playlist.name, subtitle, YES, count > 0)];
        }
        return rows;
    }
    if ([parentId isEqualToString:@"artists"]) {
        NSMutableArray *rows = [NSMutableArray new];
        for (MPMediaItemCollection *artist in [MPMediaQuery artistsQuery].collections) {
            MPMediaItem *item = artist.representativeItem;
            if (!item) continue;
            [rows addObject:BrowseRow([@"artist:" stringByAppendingString:IdString(item.artistPersistentID)],
                item.artist.length ? item.artist : @"Unknown Artist", nil, YES, YES)];
        }
        return rows;
    }
    if ([parentId isEqualToString:@"albums"]) return [self albumRows:[MPMediaQuery albumsQuery]];
    if ([parentId isEqualToString:@"songs"]) return [self songRows:[MPMediaQuery songsQuery].items ?: @[] context:@"songs"];
    if ([parentId hasPrefix:@"artist:"]) {
        MPMediaEntityPersistentID artistId;
        if (!ParseId([parentId substringFromIndex:7], &artistId)) return nil;
        MPMediaQuery *query = [MPMediaQuery albumsQuery];
        [query addFilterPredicate:[MPMediaPropertyPredicate predicateWithValue:@(artistId)
            forProperty:MPMediaItemPropertyArtistPersistentID]];
        return [self albumRows:query];
    }
    if ([parentId hasPrefix:@"playlist:"] || [parentId hasPrefix:@"album:"]) {
        return [self songRows:[self itemsForCollection:parentId] context:parentId];
    }
    return nil;
}

- (void)browse:(NSString *)parentId completion:(void (^)(NSString *, NSString *))completion {
    // Library queries can take a while on large libraries; keep them off the main thread.
    dispatch_async(self.libraryQueue, ^{
        NSString *json = nil, *error = nil;
        if (![self hasPermission]) {
            error = @"Apple Music access is not allowed";
        } else {
            @try {
                NSArray *rows = [self childrenOf:parentId ?: @""];
                if (rows) json = JsonString(rows, nil);
                if (!json) error = rows ? @"Library listing failed" : @"Unknown library item";
            } @catch (NSException *exception) {
                error = exception.reason ?: @"Library unavailable";
            }
        }
        dispatch_async(dispatch_get_main_queue(), ^{ completion(json, error); });
    });
}

- (void)play:(NSString *)mediaId completion:(void (^)(NSString *))completion {
    dispatch_async(self.libraryQueue, ^{
        NSString *collectionId = mediaId ?: @"";
        MPMediaEntityPersistentID startId = 0;
        BOOL hasStart = NO;
        if ([collectionId hasPrefix:@"song:"]) {
            NSRange at = [collectionId rangeOfString:@"@"];
            if (at.location == NSNotFound) collectionId = @"";
            else {
                hasStart = ParseId([collectionId substringWithRange:NSMakeRange(5, at.location - 5)], &startId);
                collectionId = [collectionId substringFromIndex:at.location + 1];
            }
        }
        NSArray<MPMediaItem *> *items = @[];
        NSString *error = nil;
        if (![self hasPermission]) {
            error = @"Apple Music access is not allowed";
        } else {
            @try {
                items = [self itemsForCollection:collectionId];
            } @catch (NSException *exception) {
                error = exception.reason ?: @"Library unavailable";
            }
            if (!error && !items.count) error = @"Nothing to play";
        }
        MPMediaItem *start = nil;
        if (hasStart) {
            for (MPMediaItem *item in items) {
                if (item.persistentID == startId) { start = item; break; }
            }
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            if (error) {
                completion(error);
                return;
            }
            MPMusicPlayerController *player = MPMusicPlayerController.systemMusicPlayer;
            MPMusicPlayerMediaItemQueueDescriptor *descriptor = [[MPMusicPlayerMediaItemQueueDescriptor alloc]
                initWithItemCollection:[MPMediaItemCollection collectionWithItems:items]];
            if (start) descriptor.startItem = start;
            [player setQueueWithDescriptor:descriptor];
            [player play];
            self.queueItems = items;
            self.queueConfirmed = NO;
            self.queueSetAt = [NSDate date];
            [self notifyChanged];
            completion(nil);
        });
    });
}
@end
