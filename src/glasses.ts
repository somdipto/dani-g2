import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  StartUpPageCreateResult,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { Input } from './store';
import type { Page } from './view';

/** Builds the SDK containers for a page. Pure, so tests can validate every screen against the SDK's own rules. */
export function containersFor(page: Page) {
  let id = 1;
  const captureOnList = !!page.list;
  const texts: TextContainerProperty[] = page.texts.map((t) => new TextContainerProperty({
    xPosition: t.x,
    yPosition: t.y,
    width: t.w,
    height: t.h,
    containerID: id++,
    containerName: t.name,
    content: t.content,
    isEventCapture: !captureOnList && t.capture ? 1 : 0,
    paddingLength: 4,
  }));
  const lists: ListContainerProperty[] = page.list
    ? [
        new ListContainerProperty({
          xPosition: page.list.x,
          yPosition: page.list.y,
          width: page.list.w,
          height: page.list.h,
          containerID: id++,
          containerName: page.list.name,
          isEventCapture: 1,
          itemContainer: new ListItemContainerProperty({
            itemCount: page.list.items.length,
            itemName: page.list.items,
            isItemSelectBorderEn: 1,
          }),
        }),
      ]
    : [];
  const fields = {
    containerTotalNum: texts.length + lists.length,
    textObject: texts,
    listObject: lists,
    ...(page.menu
      ? {
          menuObject: new MenuContainerProperty({
            menuItems: page.menu.map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.name })),
          }),
        }
      : {}),
  };
  return fields;
}

/** Turns a Page description into SDK containers and sends it to the glasses. */
export class GlassesView {
  private started = false;
  constructor(private bridge: EvenAppBridge) {}

  async show(page: Page): Promise<void> {
    const fields = containersFor(page);
    if (!this.started) {
      const res = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(fields));
      if (res !== StartUpPageCreateResult.success) throw new Error(`createStartUpPageContainer failed: ${res}`);
      this.started = true;
    } else {
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(fields));
      if (!ok) throw new Error('rebuildPageContainer failed');
    }
  }
}

/**
 * Maps SDK events to app input. A click can arrive with no eventType (protobuf default 0),
 * so a missing type is treated as a click.
 */
export function toInput(event: EvenHubEvent): Input | undefined {
  if (event.menuItemClickEvent) {
    const id = event.menuItemClickEvent.itemID;
    return typeof id === 'number' ? { type: 'menu', id } : undefined;
  }
  const inner = event.listEvent ?? event.textEvent ?? event.sysEvent;
  if (!inner) return undefined;
  const type = inner.eventType ?? OsEventTypeList.CLICK_EVENT;
  const index = 'currentSelectItemIndex' in inner ? (inner.currentSelectItemIndex ?? 0) : 0;
  if (type === OsEventTypeList.CLICK_EVENT) return { type: 'click', index };
  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return { type: 'back' };
  return undefined;
}
