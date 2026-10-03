#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "Utils.h"

@interface SupacodeMarkdownTextManager : RCTViewManager
@end

@implementation SupacodeMarkdownTextManager

RCT_EXPORT_MODULE(SupacodeMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface SupacodeMarkdownTextRunManager : RCTViewManager
@end

@implementation SupacodeMarkdownTextRunManager

RCT_EXPORT_MODULE(SupacodeMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
