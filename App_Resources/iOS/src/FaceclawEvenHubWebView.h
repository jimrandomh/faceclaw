#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

/** One local EHPK runtime, retained by its TS session until its window closes. */
@interface FaceclawEvenHubWebView : NSObject <WKScriptMessageHandler, WKNavigationDelegate, WKURLSchemeHandler>
@property(nonatomic, copy) void (^eventHandler)(NSString *json);
@property(nonatomic, copy) NSString *packageIdentifier;
- (void)start:(NSString *)directory entrypoint:(NSString *)entrypoint script:(NSString *)script;
- (void)evaluate:(NSString *)script;
- (void)showOnPhone;
- (void)hideOnPhone;
- (void)destroy;
@end
