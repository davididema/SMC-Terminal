'use client';

import React, { useEffect } from 'react';
import { buildNotificationView } from '@/lib/ui/notification-view';
import { getSymbolConfig } from '@/lib/deriv/symbols';
import type { GeneratedSignalEvent } from '@/lib/notifications/types';
import {
  isDesktopDeliveryActive,
  type DesktopPermissionState,
} from '@/lib/notifications/desktop';

// Compile-time gate. Next.js statically replaces `process.env.NODE_ENV`, so in a
// production build this is the literal `false` and the dev test control below is
// dead-code eliminated from the client bundle.
const TEST_CONTROLS_ENABLED = process.env.NODE_ENV !== 'production';

interface NotificationCenterProps {
  notifications: GeneratedSignalEvent[];
  onDismiss: (signalId: string) => void;
  onClear: () => void;
  desktopState: DesktopPermissionState;
  /** The user's stored desktop opt-in (consent), independent of browser permission. */
  desktopPreferenceEnabled: boolean;
  onEnableDesktop: () => void;
  soundEnabled: boolean;
  onToggleSound: (value: boolean) => void;
  storageAvailable?: boolean;
  /**
   * Development-only manual delivery test. When omitted (as in production) the
   * control is not rendered.
   */
  onSendTestNotification?: () => void;
  /** Whether the notification drawer/overlay is open */
  isOpen?: boolean;
  /** Callback to close the drawer/overlay */
  onClose?: () => void;
}

export function NotificationCenter({
  notifications,
  onDismiss,
  onClear,
  desktopState,
  desktopPreferenceEnabled,
  onEnableDesktop,
  soundEnabled,
  onToggleSound,
  storageAvailable = false,
  onSendTestNotification,
  isOpen = true,
  onClose,
}: NotificationCenterProps) {
  // The displayed status must agree with actual dispatch: desktop alerts are
  // delivered only when the user opted in AND the browser granted permission.
  const desktopActive = isDesktopDeliveryActive(desktopPreferenceEnabled, desktopState);

  // Close notification interface on Escape key press when open
  useEffect(() => {
    if (!isOpen || !onClose) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  return (
    <>
      {/* Translucent backdrop on mobile when drawer is open */}
      {isOpen && onClose && (
        <div
          className="notification-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <div
        className={`notification-center ${isOpen ? 'is-open' : 'is-closed'}`}
        aria-live="polite"
        role="region"
        aria-label="Signal Notifications"
        aria-hidden={!isOpen}
      >
        <div className="notification-center-header">
          <span className="notification-center-title">
            NEW SIGNAL NOTIFICATIONS ({notifications.length})
          </span>
          <div className="notification-header-actions">
            {notifications.length > 0 && (
              <button
                className="notification-clear"
                onClick={onClear}
                title="Clear all notifications"
              >
                CLEAR ALL
              </button>
            )}
            {onClose && (
              <button
                type="button"
                className="notification-drawer-close"
                onClick={onClose}
                title="Close notifications drawer"
                aria-label="Close notifications drawer"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="notification-settings">
          <div className="notification-setting">
            {desktopActive ? (
              <span className="notification-setting-status ok">Desktop notifications enabled</span>
            ) : desktopState === 'denied' ? (
              <span className="notification-setting-status warn">
                Desktop notifications blocked — enable them in your browser settings
              </span>
            ) : desktopState === 'default' || desktopState === 'granted' ? (
              <button className="header-btn" onClick={onEnableDesktop}>
                ENABLE DESKTOP NOTIFICATIONS
              </button>
            ) : (
              <span className="notification-setting-status muted">
                Desktop notifications unavailable in this browser
              </span>
            )}
          </div>

          <label className="notification-setting notification-toggle">
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={(e) => onToggleSound(e.target.checked)}
            />
            <span>Sound alerts</span>
          </label>

          {TEST_CONTROLS_ENABLED && onSendTestNotification && (
            <div className="notification-setting">
              <button className="header-btn" onClick={onSendTestNotification}>
                SEND TEST NOTIFICATION (DEV)
              </button>
            </div>
          )}

          <div className="notification-note">
            Desktop alerts require this dashboard to stay open. Background and closed-browser
            alerts are planned for a later phase.
            {!storageAvailable && ' Preferences cannot be saved in this browser context.'}
          </div>
        </div>

        <div className="notification-list">
          {notifications.length === 0 ? (
            <div className="notification-empty">No new signals yet.</div>
          ) : (
            notifications.map((event) => {
              if (event.isTest) {
                return (
                  <div key={event.signalId} className="notification-item notification-item-test">
                    <div className="notification-item-top">
                      <span className="notification-item-label">NOTIFICATION TEST</span>
                      <button
                        className="notification-dismiss"
                        title="Dismiss"
                        onClick={() => onDismiss(event.signalId)}
                      >
                        ×
                      </button>
                    </div>

                    <div className="notification-item-title notification-test-title">
                      Delivery test — this is not a trading signal
                    </div>

                    <div className="notification-details mono">
                      <div className="notification-detail-row">
                        <span>Purpose:</span>
                        <span>Verify in-app delivery and sound</span>
                      </div>
                      <div className="notification-detail-row">
                        <span>Source:</span>
                        <span>Manual (development only)</span>
                      </div>
                    </div>

                    <div className="notification-validity">
                      Not a LONG or SHORT signal and never stored as a trading signal.
                    </div>
                  </div>
                );
              }

              const config = getSymbolConfig(event.symbolId);
              const view = buildNotificationView({
                signal: event.signal,
                symbolId: event.symbolId,
                displayName: config?.displayName,
                timeframe: event.timeframe,
                decimals: config?.pipSize,
              });
              const color = view.direction === 'LONG' ? '#10b981' : '#f43f5e';

              return (
                <div key={event.signalId} className="notification-item">
                  <div className="notification-item-top">
                    <span className="notification-item-label">{view.label}</span>
                    <button
                      className="notification-dismiss"
                      title="Dismiss"
                      onClick={() => onDismiss(event.signalId)}
                    >
                      ×
                    </button>
                  </div>

                  <div className="notification-item-title" style={{ color }}>
                    {view.title}
                  </div>

                  <div className="notification-details mono">
                    <div className="notification-detail-row">
                      <span>Setup:</span>
                      <span>{view.setup}</span>
                    </div>
                    <div className="notification-detail-row">
                      <span>Entry:</span>
                      <span>{view.entry}</span>
                    </div>
                    <div className="notification-detail-row">
                      <span>Stop Loss:</span>
                      <span>{view.stopLoss}</span>
                    </div>
                    <div className="notification-detail-row">
                      <span>Take Profit:</span>
                      <span>{view.takeProfit}</span>
                    </div>
                    <div className="notification-detail-row">
                      <span>Risk/Reward:</span>
                      <span>{view.riskReward}</span>
                    </div>
                    <div className="notification-detail-row">
                      <span>Confidence:</span>
                      <span>{view.confidence}</span>
                    </div>
                    <div className="notification-detail-row">
                      <span>Signal Time ({view.timezoneLabel}):</span>
                      <span>{view.signalTime}</span>
                    </div>
                  </div>

                  <div className="notification-validity">{view.validityNote}</div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
