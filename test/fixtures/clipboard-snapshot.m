#import <AppKit/AppKit.h>
int main(int argc, const char *argv[]) { @autoreleasepool {
  if (argc != 3) return 2;
  NSPasteboard *pb=NSPasteboard.generalPasteboard;
  NSString *path=[NSString stringWithUTF8String:argv[2]];
  if (strcmp(argv[1], "save")==0) {
    NSMutableArray *items=[NSMutableArray array];
    for(NSPasteboardItem *item in pb.pasteboardItems) { NSMutableDictionary *data=[NSMutableDictionary dictionary]; for(NSString *type in item.types) { NSData *bytes=[item dataForType:type]; if(bytes) data[type]=bytes; } [items addObject:data]; }
    return [items writeToFile:path atomically:YES] ? 0 : 1;
  }
  NSArray *saved=[NSArray arrayWithContentsOfFile:path]; if(!saved) return 1;
  NSMutableArray *items=[NSMutableArray array];
  for(NSDictionary *data in saved) { NSPasteboardItem *item=[NSPasteboardItem new]; for(NSString *type in data) [item setData:data[type] forType:type]; [items addObject:item]; }
  [pb clearContents]; if(items.count) [pb writeObjects:items];
  return 0;
}}
