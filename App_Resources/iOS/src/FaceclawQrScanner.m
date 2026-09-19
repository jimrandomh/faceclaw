#import "FaceclawQrScanner.h"
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>

@interface FaceclawQrScreen : UIViewController
@property(nonatomic) AVCaptureVideoPreviewLayer *preview;
@property(nonatomic, copy) void (^cancelHandler)(void);
@end

@implementation FaceclawQrScreen
- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = UIColor.blackColor;
    self.title = @"Scan app QR code";
    self.navigationItem.leftBarButtonItem = [[UIBarButtonItem alloc]
        initWithBarButtonSystemItem:UIBarButtonSystemItemCancel target:self action:@selector(cancelScan)];
    UILabel *instructions = [UILabel new];
    instructions.text = @"Point the camera at the app's QR code.";
    instructions.textColor = UIColor.whiteColor;
    instructions.backgroundColor = [UIColor.blackColor colorWithAlphaComponent:0.7];
    instructions.textAlignment = NSTextAlignmentCenter;
    instructions.numberOfLines = 0;
    instructions.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
    instructions.adjustsFontForContentSizeCategory = YES;
    instructions.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:instructions];
    [NSLayoutConstraint activateConstraints:@[
        [instructions.leadingAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.leadingAnchor constant:20],
        [instructions.trailingAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.trailingAnchor constant:-20],
        [instructions.bottomAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.bottomAnchor constant:-24],
    ]];
}
- (void)cancelScan { if (_cancelHandler) _cancelHandler(); }
- (void)viewDidLayoutSubviews {
    [super viewDidLayoutSubviews];
    _preview.frame = self.view.bounds;
    UIInterfaceOrientation orientation = self.view.window.windowScene.interfaceOrientation;
    if (_preview.connection.isVideoOrientationSupported && orientation != UIInterfaceOrientationUnknown)
        _preview.connection.videoOrientation = (AVCaptureVideoOrientation)orientation;
}
@end

@interface FaceclawQrScanner () <AVCaptureMetadataOutputObjectsDelegate>
@property(nonatomic) AVCaptureSession *session;
@property(nonatomic) AVCaptureMetadataOutput *output;
@property(nonatomic) dispatch_queue_t cameraQueue;
@property(nonatomic) FaceclawQrScreen *screen;
@property(nonatomic) UINavigationController *navigation;
@property(nonatomic, copy) void (^completion)(NSString *, NSString *);
@property(atomic) BOOL finished;
@property(nonatomic) BOOL presenting;
@property(nonatomic) BOOL stopped;
@property(nonatomic) BOOL closing;
@property(nonatomic) NSString *resultText;
@property(nonatomic) NSString *resultError;
@end

@implementation FaceclawQrScanner
+ (BOOL)isAvailable { return [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo] != nil; }
- (void)startWithCompletion:(void (^)(NSString *, NSString *))completion {
    NSAssert(NSThread.isMainThread, @"Start QR scanner on the main thread");
    if (_completion || _finished) { completion(nil, @"This QR scanner has already been used."); return; }
    _completion = [completion copy];
    _cameraQueue = dispatch_queue_create("com.faceclaw.qr-camera", DISPATCH_QUEUE_SERIAL);
    if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) {
        [self finish:nil error:@"Open Faceclaw on your iPhone to scan a QR code."]; return;
    }
    if (![FaceclawQrScanner isAvailable]) {
        [self finish:nil error:@"No camera is available on this device."]; return;
    }
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(backgrounded:)
        name:UIApplicationDidEnterBackgroundNotification object:nil];
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    if (status == AVAuthorizationStatusNotDetermined) {
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (self.finished) return;
                if (granted) [self presentScanner];
                else [self finish:nil error:@"Camera access denied. Allow Camera for Faceclaw in iPhone Settings, then scan again."];
            });
        }];
    } else if (status == AVAuthorizationStatusAuthorized) [self presentScanner];
    else [self finish:nil error:@"Camera access is unavailable. Check Camera permission for Faceclaw in iPhone Settings."];
}
- (void)presentScanner {
    if (_finished) return;
    UIViewController *presenter = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class] || scene.activationState != UISceneActivationStateForegroundActive) continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows)
            if (window.isKeyWindow) presenter = window.rootViewController;
    }
    // NativeScript also supports the legacy, non-scene app lifecycle.
    if (!presenter) presenter = UIApplication.sharedApplication.keyWindow.rootViewController;
    while (presenter.presentedViewController) presenter = presenter.presentedViewController;
    if (!presenter.view.window || presenter.isBeingDismissed || presenter.isBeingPresented || [presenter isKindOfClass:UIAlertController.class]) {
        [self finish:nil error:@"Close the phone dialog and open Faceclaw to scan again."]; return;
    }
    _screen = [FaceclawQrScreen new];
    __weak FaceclawQrScanner *weakSelf = self;
    _screen.cancelHandler = ^{ [weakSelf cancel]; };
    _navigation = [[UINavigationController alloc] initWithRootViewController:_screen];
    _navigation.modalPresentationStyle = UIModalPresentationFullScreen;
    _navigation.overrideUserInterfaceStyle = UIUserInterfaceStyleDark;
    _presenting = YES;
    [presenter presentViewController:_navigation animated:YES completion:^{
        self.presenting = NO;
        if (self.finished) [self closeScanner];
        else [self configureCamera];
    }];
}
- (void)configureCamera {
    _session = [AVCaptureSession new];
    _screen.preview = [AVCaptureVideoPreviewLayer layerWithSession:_session];
    _screen.preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
    [_screen.view.layer insertSublayer:_screen.preview atIndex:0];
    [_screen.view setNeedsLayout];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(cameraFailed:)
        name:AVCaptureSessionRuntimeErrorNotification object:_session];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(cameraInterrupted:)
        name:AVCaptureSessionWasInterruptedNotification object:_session];
    dispatch_async(_cameraQueue, ^{
        if (self.finished) return;
        NSError *error = nil;
        AVCaptureDevice *camera = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
        AVCaptureDeviceInput *input = camera ? [AVCaptureDeviceInput deviceInputWithDevice:camera error:&error] : nil;
        AVCaptureMetadataOutput *output = [AVCaptureMetadataOutput new];
        [self.session beginConfiguration];
        if (input && [self.session canAddInput:input]) [self.session addInput:input];
        if (self.session.inputs.count && [self.session canAddOutput:output]) [self.session addOutput:output];
        BOOL ready = [output.availableMetadataObjectTypes containsObject:AVMetadataObjectTypeQRCode];
        if (ready) {
            self.output = output;
            [output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
            output.metadataObjectTypes = @[AVMetadataObjectTypeQRCode];
        }
        [self.session commitConfiguration];
        if (!ready) {
            dispatch_async(dispatch_get_main_queue(), ^{ [self finish:nil error:error.localizedDescription ?: @"Could not start the QR camera. Try scanning again."]; });
            return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{ [self.screen.view setNeedsLayout]; });
        if (!self.finished) [self.session startRunning];
    });
}
- (void)metadataOutput:(AVCaptureMetadataOutput *)output didOutputMetadataObjects:(NSArray<__kindof AVMetadataObject *> *)objects fromConnection:(AVCaptureConnection *)connection {
    for (AVMetadataObject *object in objects) {
        if (![object.type isEqual:AVMetadataObjectTypeQRCode] || ![object isKindOfClass:AVMetadataMachineReadableCodeObject.class]) continue;
        NSString *text = ((AVMetadataMachineReadableCodeObject *)object).stringValue;
        if (text.length) { [self finish:text error:nil]; return; }
    }
}
- (void)cameraFailed:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{ [self finish:nil error:@"The camera stopped. Try scanning again."]; });
}
- (void)cameraInterrupted:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{ [self finish:nil error:@"Camera interrupted. Return to Faceclaw and scan again."]; });
}
- (void)backgrounded:(NSNotification *)notification { [self cancel]; }
- (void)cancel { [self finish:nil error:nil]; }
- (void)finish:(NSString *)text error:(NSString *)error {
    if (_finished) return;
    self.finished = YES;
    _resultText = text; _resultError = error;
    [NSNotificationCenter.defaultCenter removeObserver:self];
    // Serialize teardown after any pending setup/start. Never block the UI.
    dispatch_async(_cameraQueue, ^{
        [self.output setMetadataObjectsDelegate:nil queue:NULL];
        [self.session stopRunning];
        dispatch_async(dispatch_get_main_queue(), ^{ self.stopped = YES; [self closeScanner]; });
    });
}
- (void)closeScanner {
    if (!_stopped || _presenting || _closing) return;
    _closing = YES;
    void (^done)(void) = ^{
        void (^completion)(NSString *, NSString *) = self.completion;
        self.completion = nil;
        self.screen.preview.session = nil;
        self.screen = nil; self.navigation = nil; self.session = nil; self.output = nil;
        if (completion) completion(self.resultText, self.resultError);
    };
    if (_navigation.presentingViewController) [_navigation dismissViewControllerAnimated:YES completion:done];
    else done();
}
@end
