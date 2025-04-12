import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

// Define the extension class
export default class TopPanelAlwaysVisible extends Extension {
  enable() {
    this._enabled = true;

    // Timer: runs every 1000ms to check fullscreen state and force panel visibility if needed
    this._forceVisibleLoop = GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => {
      if (!this._enabled)
        return GLib.SOURCE_CONTINUE;

      // Check if the currently focused window is in fullscreen
      const focused = global.display.get_focus_window();
      const isFullscreen = focused?.get_window_type() === Meta.WindowType.NORMAL &&
                           focused?.is_fullscreen?.();

      if (isFullscreen) {
        Main.layoutManager.panelBox.visible = true; // Force panel visible
      }

      return GLib.SOURCE_CONTINUE; // Keep the loop going
    });

    // Right-click handler to toggle the visibility enforcement on/off
    this._clickHandler = Main.panel.actor.connect('button-press-event', (actor, event) => {
      if (event.get_button() === Clutter.BUTTON_SECONDARY) {
        this._enabled = !this._enabled; // Toggle the feature state

        if (!this._enabled) {
          // If turning off, flash twice and hide panel if in fullscreen
          const focused = global.display.get_focus_window();
          const isFullscreen = focused?.get_window_type() === Meta.WindowType.NORMAL &&
                               focused?.is_fullscreen?.();
          this._flashPanel(2); // Double flash: feature OFF

          if (isFullscreen) {
            Main.layoutManager.panelBox.visible = false; // Hide panel immediately
          }
        } else {
          this._flashPanel(1); // Single flash: feature ON
        }

        return Clutter.EVENT_STOP; // Prevent right-click menu from opening
      }

      return Clutter.EVENT_PROPAGATE;
    });
  }

  // Cleanup when extension is disabled
  disable() {
    if (this._forceVisibleLoop) {
      GLib.source_remove(this._forceVisibleLoop);
      this._forceVisibleLoop = null;
    }

    if (this._clickHandler) {
      Main.panel.actor.disconnect(this._clickHandler);
      this._clickHandler = null;
    }
  }

  // Flash function: dims and restores panel opacity once or twice
  _flashPanel(counter) {
    if (counter === 1) {
      // Single flash
      Main.panel.actor.opacity = 80;
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        Main.panel.actor.opacity = 255;
        return GLib.SOURCE_REMOVE;
      });
    }

    if (counter === 2) {
      // First flash
      Main.panel.actor.opacity = 80;
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        Main.panel.actor.opacity = 255;
        return GLib.SOURCE_REMOVE;
      });

      // Second flash after delay
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        Main.panel.actor.opacity = 80;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
          Main.panel.actor.opacity = 255;
          return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
      });
    }
  }
}

