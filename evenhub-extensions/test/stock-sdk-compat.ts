// Compile-only check (run by `npm run check`): the stock SDK's container and
// page classes must be accepted wherever the extended layout types are, so
// apps can keep using the stock builders with createLayout/replaceLayout.
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { getInputSource } from "../src/index";
import type {
  FaceclawExtensions,
  InputSource,
  FaceclawImageContainer,
  FaceclawLayout,
  FaceclawListContainer,
  FaceclawMenu,
  FaceclawTextContainer,
} from "../src/index";

const text = new TextContainerProperty({
  containerID: 1,
  containerName: "title",
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 40,
  content: "Hello",
  textColor: 3,
  isEventCapture: 1,
});
const image = new ImageContainerProperty({ containerID: 2, containerName: "art", width: 576, height: 400 });
const list = new ListContainerProperty({
  containerID: 3,
  containerName: "menu",
  itemContainer: new ListItemContainerProperty({ itemName: ["One", "Two"], isItemSelectBorderEn: 1 }),
});
const menu = new MenuContainerProperty({ menuItems: [new MenuItemProperty({ itemID: 1, itemName: "Reset" })] });

const asText: FaceclawTextContainer = text;
const asImage: FaceclawImageContainer = image;
const asList: FaceclawListContainer = list;
const asMenu: FaceclawMenu = menu;
void [asText, asImage, asList, asMenu];

const fromCreate: FaceclawLayout = new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [text] });
const fromRebuild: FaceclawLayout = new RebuildPageContainer({ imageObject: [image] });

// Stock instances mixed with the extended fields in a literal.
const mixed: FaceclawLayout = {
  containerTotalNum: 3,
  textObject: [Object.assign(new TextContainerProperty({ containerID: 1, containerName: "title" }), { preserve: true })],
  imageObject: [image],
  listObject: [list],
  menuObject: menu,
};

declare const fc: FaceclawExtensions;
void fc.createLayout(fromCreate);
void fc.replaceLayout(fromRebuild);
void fc.replaceLayout(mixed);
void fc.replaceLayout(new RebuildPageContainer({ textObject: [new TextContainerProperty({ containerID: 1 })] }));

// The stock event the SDK hands onEvenHubEvent carries the source field.
declare const stockEvent: EvenHubEvent;
const source: InputSource | null = getInputSource(stockEvent);
void source;

// A canvas ImageData is accepted as a window icon.
declare const imageData: ImageData;
void fc.setWindowIcon(imageData);
