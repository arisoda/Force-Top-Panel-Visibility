import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import GLib from 'gi://GLib';

// Registers GObject class, using provided metadata if available
function registerGObjectClass(target) {
  if (Object.prototype.hasOwnProperty.call(target, "metaInfo")) {
    return GObject.registerClass(target.metaInfo, target);
  } else {
    return GObject.registerClass(target);
  }
}

// Wrapper for a pressure-sensitive screen edge + native barrier
class Barrier {
  constructor(position, hitDirection, triggerMode, triggerAction) {
    this.position = position;
    this.hitDirection = hitDirection; // 1 = from bottom, 0 = from top
    this.triggerMode = triggerMode;   // 1 = delayed trigger
    this.triggerAction = triggerAction;
  }

  // Only apply pressure threshold and delay if in delayed trigger mode
  activate() {
    this.pressureBarrier = new Layout.PressureBarrier(
      this.triggerMode === 1 ? 15 : 0, // threshold
      this.triggerMode === 1 ? 200 : 0, // timeout
      Shell.ActionMode.NORMAL
    );
    this.pressureBarrier.connect("trigger", this.onTrigger.bind(this));

    const { x1, x2, y1, y2 } = this.position;
    this.nativeBarrier = new Meta.Barrier({
      backend: global.backend,
      x1,
      x2,
      y1,
      y2,
      directions: this.hitDirection === 1
        ? Meta.BarrierDirection.POSITIVE_Y
        : Meta.BarrierDirection.NEGATIVE_Y,
    });

    this.pressureBarrier.addBarrier(this.nativeBarrier);
  }

  onTrigger() {
    this.triggerAction();
  }

  // Destroys both barriers
  dispose() {
    if (!this.nativeBarrier) return;
    this.pressureBarrier?.removeBarrier(this.nativeBarrier);
    this.nativeBarrier.destroy();
    this.nativeBarrier = null;
    this.pressureBarrier?.destroy();
    this.pressureBarrier = null;
  }
}

// Polling-based detector that calls leaveAction when cursor exits defined bounds
class CursorPositionLeaveDetector {
  constructor(position, hitDirection, leaveAction, leaveCondition) {
    this.position = position;
    this.leaveAction = leaveAction;
    this.leaveCondition = leaveCondition;
    this.timeoutId = null;
    this.boundsChecker = hitDirection === 1 ? this.fromBottomBoundsChecker : this.fromTopBoundsChecker;
  }

  // Start polling cursor position; triggers leaveAction when outside bounds and condition is true
  activate() {
    this.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      if (!this.isOutOfBounds() || !this.leaveCondition?.()) {
        return GLib.SOURCE_CONTINUE;
      }
      this.leaveAction();
      return GLib.SOURCE_REMOVE;
    });
  }

  dispose() {
    if (this.timeoutId) {
      GLib.source_remove(this.timeoutId);
      this.timeoutId = null;
    }
  }

  // Checks if mouse is outside of monitored zone
  isOutOfBounds() {
    let [_, mouse_y, __] = global.get_pointer();
    return this.boundsChecker(mouse_y);
  }

  // Checker for top-bound leave
  fromTopBoundsChecker(mouseY) {
    return this.position.y1 < mouseY;
  }

  // Checker for bottom-bound leave
  fromBottomBoundsChecker(mouseY) {
    return this.position.y1 > mouseY;
  }
}

// Actor that defines an invisible top-edge trigger area for cursor peeking
let HotEdge = class HotEdge extends Clutter.Actor {
  constructor(monitor, leaveOffset, triggerAction, leaveAction, leaveCondition) {
    super();
    this.monitor = monitor;
    this.leaveOffset = leaveOffset;
    this.triggerAction = triggerAction;
    this.leaveAction = leaveAction;
    this.leaveCondition = leaveCondition;
    this.barrier = null;
    this.leaveDetector = null;
    this._isTriggered = false;
    this.connect("destroy", this.dispose.bind(this));
  }

  // Initialize edge barrier and trigger logic
  initialize() {
    const { x, y, width } = this.monitor;
    this.barrier = new Barrier(
      { x1: x, x2: x + width, y1: y + 1, y2: y + 1 },
      1, // From bottom
      1, // Delayed
      this.onEnter.bind(this)
    );
    this.barrier.activate();
  }

  // Triggered when cursor hits edge
  onEnter() {
    if (this._isTriggered) return;
    this._isTriggered = true;
    const { x, y, width } = this.monitor;
    this.leaveDetector = new CursorPositionLeaveDetector(
      { x1: x, x2: x + width, y1: y + this.leaveOffset, y2: y + this.leaveOffset },
      0, // From top
      this.onLeave.bind(this),
      this.leaveCondition
    );
    this.leaveDetector.activate();
    this.triggerAction();
  }

  // Triggered when cursor leaves panel zone
  onLeave() {
    if (!this._isTriggered) return;
    this._isTriggered = false;
    this.disposeOfLeaveDetector();
    this.leaveAction();
  }

  dispose() {
    this.barrier?.dispose();
    this.barrier = null;
    this.disposeOfLeaveDetector();
  }

  disposeOfLeaveDetector() {
    this.leaveDetector?.dispose();
    this.leaveDetector = null;
  }
};
HotEdge = registerGObjectClass(HotEdge);

// Returns true if GNOME considers the monitor fullscreen (used for peeking logic))
function isFullscreen(monitor) {
  return monitor.inFullscreen;
}

// Check if GNOME is in Overview mode
function isInOverview() {
  return Main.layoutManager._inOverview;
}

// Main extension class
export default class MergedTopPanelExtension extends Extension {
  enable() {
    // Launch dummy X11 window if not on Wayland
    if (!Meta.is_wayland_compositor()) {
      GLib.spawn_command_line_async(`sh -c "GDK_BACKEND=x11 gjs ${this.path}/dummy-window.js"`);
    }

    this._hotEdge = null;
    this._hotCornersSub = null;
    this._enforceVisible = true;

    // Force panel visible every second if enforceVisible is true
    this._forceVisibleLoop = GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => {
      if (!this._enforceVisible) return GLib.SOURCE_CONTINUE;
      const focused = global.display.get_focus_window();
      const monitor = Main.layoutManager.primaryMonitor;
      const isFullscreen =
        focused &&
        focused.get_window_type() === Meta.WindowType.NORMAL &&
        focused.get_monitor() === monitor.index &&
        focused.get_frame_rect().width >= monitor.width &&
        focused.get_frame_rect().height >= monitor.height;

      if (isFullscreen) Main.layoutManager.panelBox.visible = true;
      return GLib.SOURCE_CONTINUE;
    });

    // Right-click toggles panel visibility enforcement
    this._clickHandler = Main.panel.actor.connect('button-press-event', (actor, event) => {
      if (event.get_button() === Clutter.BUTTON_SECONDARY) {
        this._enforceVisible = !this._enforceVisible;
        this._flashPanel(this._enforceVisible ? 1 : 2);

        if (!this._enforceVisible) {
          const focused = global.display.get_focus_window();
          const monitor = Main.layoutManager.primaryMonitor;
          const isFullscreen =
            focused &&
            focused.get_window_type() === Meta.WindowType.NORMAL &&
            focused.get_monitor() === monitor.index &&
            focused.get_frame_rect().width >= monitor.width &&
            focused.get_frame_rect().height >= monitor.height;

          if (isFullscreen) Main.layoutManager.panelBox.visible = false;
        }
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    // Re-setup hot edge when hot corners setting changes
    const layoutManager = Main.layoutManager;
    this._hotCornersSub = layoutManager.connect("hot-corners-changed", () => this._setupHotEdge());
    this._setupHotEdge();
  }

  _setupHotEdge() {
    this._hotEdge?.dispose();
    const monitor = Main.layoutManager.primaryMonitor;

    // Instantiate bottom hot edge
    this._hotEdge = new HotEdge(
      monitor,
      Main.layoutManager.panelBox.height,
      () => {
        if (!isFullscreen(monitor)) return;
        Main.layoutManager.panelBox.visible = true;
        Main.layoutManager.panelBox.raise_top();
      },
      () => {
        if (!isFullscreen(monitor) || isInOverview()) return;
        if (this._enforceVisible) return;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
          if (!isFullscreen(monitor) || isInOverview()) return GLib.SOURCE_REMOVE;
          Main.layoutManager.panelBox.visible = false;
          return GLib.SOURCE_REMOVE;
        });
      },
      () => !isAnyPanelMenuOpen() || isInOverview()
    );
    this._hotEdge.initialize();
    Main.layoutManager.hotCorners.push(this._hotEdge);
  }

  disable() {
    if (this._forceVisibleLoop) GLib.source_remove(this._forceVisibleLoop);
    if (this._clickHandler) Main.panel.actor.disconnect(this._clickHandler);
    if (this._hotCornersSub) Main.layoutManager.disconnect(this._hotCornersSub);
    this._hotEdge?.dispose();
    GLib.spawn_command_line_async('pkill -f dummy-window.js');
  }

  // Flashes panel to indicate toggle state (1 = on, 2 = off)
  _flashPanel(counter) {
    const flashOnce = () => {
      Main.panel.actor.opacity = 80;
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        Main.panel.actor.opacity = 255;
        return GLib.SOURCE_REMOVE;
      });
    };
    if (counter === 1) flashOnce();
    if (counter === 2) {
      flashOnce();
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        flashOnce();
        return GLib.SOURCE_REMOVE;
      });
    }
  }
}

// Returns true if any top panel menu is open
function isAnyPanelMenuOpen() {
  const statusArea = Main.layoutManager.panelBox.get_children()[0].statusArea;
  const opennableIndicators = Object.keys(statusArea)
    .filter((indicator) => !!statusArea[indicator].menu)
    .map((indicator) => statusArea[indicator]);

  return opennableIndicators.some((indicator) => indicator.menu.isOpen);
}
