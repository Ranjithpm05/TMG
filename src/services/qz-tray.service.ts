import { Injectable } from '@angular/core';
import * as qz from 'qz-tray';

/**
 * Thin wrapper around the QZ Tray browser client (https://qz.io) — the local
 * desktop agent that lets this web app talk directly to installed printers
 * (including raw TSPL/ZPL thermal-printer command streams), bypassing the
 * browser's own print dialog entirely.
 *
 * Security mode: "unsigned". QZ Tray requires a certificate/signature promise
 * pair before it will connect; without a real signing certificate, this
 * resolves them as empty, which QZ Tray accepts but shows its own one-time
 * "Action Required" trust prompt per session (normal for internal/trusted
 * deployments — the operator just clicks Allow). If a signing certificate +
 * private key are obtained later (see https://qz.io/wiki/2.1-signing-messages),
 * swap configureSecurity() below for the real cert/signature flow to remove
 * that prompt entirely.
 */
@Injectable({ providedIn: 'root' })
export class QzTrayService {
  private securityConfigured = false;

  private configureSecurity(): void {
    if (this.securityConfigured) return;
    qz.security.setCertificatePromise((resolve: (value?: string) => void) => resolve());
    qz.security.setSignaturePromise(() => (resolve: (value?: string) => void) => resolve());
    this.securityConfigured = true;
  }

  isActive(): boolean {
    try {
      return qz.websocket.isActive();
    } catch {
      return false;
    }
  }

  async connect(): Promise<void> {
    this.configureSecurity();
    if (this.isActive()) return;
    await qz.websocket.connect();
  }

  async disconnect(): Promise<void> {
    if (this.isActive()) {
      await qz.websocket.disconnect();
    }
  }

  /** Lists printer names as registered with the OS — populates the "Detect" picker. */
  async listPrinters(): Promise<string[]> {
    await this.connect();
    return qz.printers.find();
  }

  /**
   * Sends one or more raw command strings (e.g. TSPL) to a printer exactly as
   * given — QZ Tray does not interpret or validate the command language, it
   * only relays bytes to the OS print spooler for the named printer.
   */
  async printRaw(printerName: string, commands: string[]): Promise<void> {
    await this.connect();
    const config = qz.configs.create(printerName);
    await qz.print(config, commands);
  }
}
