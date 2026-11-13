#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#include <unistd.h>

// Called only by open_gate.rs. File icons use ImageIO/CoreGraphics on a
// worker; the gate hands over an application's NSImage on the main thread.
int tb_file_icon_png(int fd, long long length, void *applicationIcon, void **output) {
  @autoreleasepool {
    *output = NULL;
    CGImageRef image = NULL;
    CGPDFDocumentRef pdf = NULL;
    if (applicationIcon) {
      NSImage *icon = (__bridge NSImage *)applicationIcon;
      NSRect rect = NSMakeRect(0, 0, 128, 128);
      image = [icon CGImageForProposedRect:&rect context:nil hints:nil];
      if (image) CGImageRetain(image);
    } else if (fd >= 0 && length > 0 && length <= 32LL * 1024 * 1024) {
      NSMutableData *bytes = [NSMutableData dataWithLength:(NSUInteger)length];
      long long at = 0;
      while (at < length) {
        ssize_t got = pread(fd, (char *)bytes.mutableBytes + at, (size_t)(length - at), at);
        if (got <= 0) break;
        at += got;
      }
      if (at != length) return 0;
      if (length >= 5 && memcmp(bytes.bytes, "%PDF-", 5) == 0) {
        CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)bytes);
        pdf = CGPDFDocumentCreateWithProvider(provider);
        CGDataProviderRelease(provider);
      } else {
        CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)bytes, NULL);
        if (source) {
          image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)@{
            (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
            (id)kCGImageSourceThumbnailMaxPixelSize: @128,
          });
          CFRelease(source);
        }
      }
    }
    CGPDFPageRef page = pdf ? CGPDFDocumentGetPage(pdf, 1) : NULL;
    if (!image && !page) { if (pdf) CGPDFDocumentRelease(pdf); return 0; }
    CGColorSpaceRef color = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(NULL, 128, 128, 8, 0, color, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(color);
    if (!context) { if (image) CGImageRelease(image); if (pdf) CGPDFDocumentRelease(pdf); return 0; }
    // Explicitly clear the padding around an icon of a different shape.
    CGContextClearRect(context, CGRectMake(0, 0, 128, 128));
    if (page) {
      CGContextConcatCTM(context, CGPDFPageGetDrawingTransform(page, kCGPDFMediaBox, CGRectMake(0, 0, 128, 128), 0, true));
      CGContextDrawPDFPage(context, page);
    } else {
      double scale = MIN(128. / CGImageGetWidth(image), 128. / CGImageGetHeight(image));
      CGSize size = CGSizeMake(CGImageGetWidth(image) * scale, CGImageGetHeight(image) * scale);
      CGContextDrawImage(context, CGRectMake((128 - size.width) / 2, (128 - size.height) / 2, size.width, size.height), image);
    }
    CGImageRef rendered = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    if (image) CGImageRelease(image);
    if (pdf) CGPDFDocumentRelease(pdf);
    if (!rendered) return 0;
    NSMutableData *png = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png, CFSTR("public.png"), 1, NULL);
    BOOL encoded = NO;
    if (destination) {
      CGImageDestinationAddImage(destination, rendered, NULL);
      encoded = CGImageDestinationFinalize(destination);
      CFRelease(destination);
    }
    CGImageRelease(rendered);
    if (!encoded || png.length > INT_MAX) return 0;
    void *copy = malloc(png.length);
    if (!copy) return 0;
    memcpy(copy, png.bytes, png.length);
    *output = copy;
    return (int)png.length;
  }
}
