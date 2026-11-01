#import <Foundation/Foundation.h>

/**
 * OAuth sign-in in the system browser sheet (ASWebAuthenticationSession, which shares
 * Safari's cookies, so a provider the user is already signed in to needs only a consent
 * tap) for providers that redirect to a loopback address: a FaceclawLoopbackRedirect
 * catches the redirect, then the sheet is closed. Presenting needs Faceclaw in the
 * foreground, so a sign-in started from the glasses waits until the user opens the app.
 * One sign-in at a time; starting another cancels the first. Call from the main thread.
 */
@interface FaceclawWebSignIn : NSObject
+ (instancetype)shared;
/**
 * completion(redirectUrl, nil) once the provider redirects to http://127.0.0.1:<port><path>;
 * (nil, "cancelled") when the user closes the sheet or cancel is called; (nil, message)
 * when the sheet or the receiver cannot start. Called once, on the main queue.
 */
- (void)signIn:(NSString *)authorizeUrl port:(NSInteger)port path:(NSString *)path
    completion:(void (^)(NSString *redirectUrl, NSString *error))completion;
- (void)cancel;
@end
