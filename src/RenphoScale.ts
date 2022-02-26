import {
  Adapter, createBluetooth, GattCharacteristic, GattServer
} from "node-ble";
import { TLogLevelName } from "tslog";

import { getLogger } from "./logging";
import { Packet, parseIncomingPacket } from "./protocol";
import { buf2hexstr, delay, makeLongUuid } from "./util";

export interface EventEmitter {
  emit(eventName: string, ...args: any[]): unknown;

  on(eventName: string, handler: (...args: any[]) => unknown): this;
  once(eventName: string, handler: (...args: any[]) => unknown): this;
  off(eventName: string, handler: (...args: any[]) => unknown): this;
}

/**
 * Events and corresponding payload arguments
 */
export interface EventTree {
  data: [packet: Packet];
  liveupdate: [weightValue: number];
  measurement: [weightValue: number];
  timeout: [];
}

export type EventName = keyof EventTree;

export interface RenphoScaleConstructorOpts {
  loglevel?: TLogLevelName;
}

/**
 * Instance for communicating with a Renpho person scale.
 *
 * *Events:*
 * - `data`: emitted for each incoming packet
 * - `liveupdate`: emitted while a person is standing on the scale.
 * - `measurement`: emitted after the scale has settled towards a weight
 * - `timeout`: emitted after no packets have been received for 10 seconds by default
 */
export class RenphoScale {
  protected readonly logger = getLogger(RenphoScale.name);
  protected listeners: Record<EventName, Array<(...args: any[]) => unknown>> = {
    liveupdate: [],
    measurement: [],
    data: [],
    timeout: [],
  };

  /**
   * Has a timer ID as value if clock is ticking
   */
  timeoutHandle?: any;

  /**
   * The GATT characterstic (= communication channel) for sending commands.
   */
  public eventChar?: GattCharacteristic;

  /**
   * Factory function for connecting to a Renpho scale.
   *
   * @param btAdapter node-ble bluetooth adapter isntance
   * @param macAddress address of the BLE scale to be connected to
   * @param opts optional configuration
   * @returns connected instance to communicate with
   */
  static async connect(
    btAdapter: Adapter,
    macAddress: string,
    opts: RenphoScaleConstructorOpts = {}
  ) {
    const logger = getLogger("connect()", { minLevel: "info" });
    logger.info(`Waiting for connection to ${macAddress}`);
    const device = await btAdapter.waitDevice(macAddress);
    await device.connect();
    logger.info(`Connected!`);
    //  TODO we can get stuck here!, need another timeout
    const gatt = await device.gatt();
    return new RenphoScale(gatt, opts);
  }

  /**
   * @param gatt node-ble GATT server to infer services and characteristics from.
   * @param opts optional configuration
   */
  constructor(public gatt: GattServer, opts: RenphoScaleConstructorOpts = {}) {}

  // /**
  //  * Translates the magic number representing a scale type (lbs, kgs, ...) into a string
  //  */
  // protected static getScaleType(magicNumber: number): string {
  //   // TODO fill this
  //   const SCALE_TYPES: Record<number, string> = { 21: "kg" };
  //   return SCALE_TYPES[magicNumber] ?? "unknown";
  // }

  /**
   * The list of listeners registered for an event
   */
  protected getListeners(eventName: string) {
    const REGISTERED_LISTENERS = [
      "liveupdate",
      "measurement",
      "data",
      "timeout",
    ];
    if (!REGISTERED_LISTENERS.includes(eventName))
      throw new Error(`Invalid event: ${eventName}`);
    return this.listeners[eventName as EventName];
  }

  /**
   *
   * Emits an event with the given payload.
   */
  protected emit(eventName: EventName, ...args: any[]): this {
    this.getListeners(eventName).forEach((fn: any) => fn(...args));
    return this;
  }

  /**
   * Registers an event listener.
   */
  on(eventName: EventName, handler?: (...args: any[]) => unknown): this {
    if (handler) this.getListeners(eventName).push(handler);
    return this;
  }

  /**
   * Registers an event listener to be run only once.
   */
  once(eventName: EventName, handler?: (...args: any[]) => unknown): this {
    if (!handler) return this;

    const wrappedHandler = (...args: any[]) => {
      this.off(eventName, wrappedHandler);
      return handler(...args);
    };
    this.on(eventName, wrappedHandler);
    return this;
  }

  /**
   * De-registers an event listener if supplied or all listeners for the event otherwise.
   */
  off(eventName: EventName, handler?: (...args: any[]) => unknown): this {
    const listeners = this.getListeners(eventName);
    if (handler) {
      const index = listeners.findIndex((fn) => fn === handler);
      if (index >= 0) listeners.splice(index, 1);
    } else {
      listeners.splice(0, listeners.length);
    }
    return this;
  }

  /**
   * Sends a command packet to the characterstic.
   */
  protected async sendCommand(char: GattCharacteristic, buf: Buffer) {
    this.logger
      .getChildLogger({
        name: "SEND 👉",
      })
      .silly(buf2hexstr(buf));
    await char.writeValue(buf);
  }

  /**
   * Processes an incoming packet and causes events to be fired.
   */
  protected async handlePacket(outChar: GattCharacteristic, p: Packet) {
    this.logger
      .getChildLogger({
        name: "RECV 📨",
      })
      .silly(buf2hexstr(p.data));

    this.emit("data", p);

    switch (p.packetId) {
      case 0x12:
        this.logger.debug(`✅ Received handshake packet 1/2`);
        // ????
        const magicBytesForFirstPacket = [
          0x13, 0x09, 0x15, 0x01, 0x10, 0x00, 0x00, 0x00, 0x42,
        ];
        await this.sendCommand(outChar, Buffer.from(magicBytesForFirstPacket));
        return;
      case 0x14:
        this.logger.debug(`✅ Received handshake packet 2/2`);
        // turn on bluetooth indicator?
        const magicBytesForSecondPacket = [
          0x20, 0x08, 0x15, 0x09, 0x0b, 0xac, 0x29, 0x26,
        ];
        await this.sendCommand(outChar, Buffer.from(magicBytesForSecondPacket));
        return;
      case 0x10:
        const flag = p.data[5];
        if (flag === 0) {
          this.emit("liveupdate", p.weightValue);
        } else if (flag === 1) {
          this.logger.debug(`✅ Received completed measurement packet`);
          // send stop packet
          await this.sendCommand(
            outChar,
            Buffer.from([0x1f, 0x05, 0x15, 0x10, 0x49])
          );
          this.emit("measurement", p.weightValue);
        }
        return;
      default:
        this.logger.warn("Unknown packet", p);
    }
  }

  /**
   * Starts the BLE listening process and an accompanying timeout.
   *
   * The `timeout` event will be fired after no message was received for `timeoutSecs` seconds.
   */
  async startListening(timeoutSecs = 10) {
    if (this.eventChar) return;

    this.logger.info(
      `Listening for data packets... (timeout after ${timeoutSecs} seconds}`
    );

    const svc = await this.gatt.getPrimaryService(makeLongUuid("ffe0"));
    const eventChar = await svc.getCharacteristic(makeLongUuid("ffe1"));
    const commandChar = await svc.getCharacteristic(makeLongUuid("ffe3"));

    let didTimeout = false;
    const handleValueChange = (buf: Buffer) => {
      if (didTimeout) return;
      this.handlePacket(commandChar, parseIncomingPacket(buf)).catch((err) =>
        this.logger.warn("Error while handling packet", err.toString())
      );
    };

    const handleTimeout = () => {
      this.logger.warn(`timeout after (${timeoutSecs}) seconds`);
      didTimeout = true;
      this.emit("timeout");
      eventChar.off("valuechanged", handleValueChange);
      this.destroy();
    };
    const resetTimer = () => {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = undefined;
      }
      this.timeoutHandle = setTimeout(handleTimeout, timeoutSecs * 1000);
    };

    eventChar.on("valuechanged", handleValueChange);

    await eventChar.startNotifications();
    this.eventChar = eventChar;
    resetTimer();

    this.on("data", () => {
      resetTimer();
    });
  }

  /**
   * Stops listening and clears resources.
   */
  async destroy() {
    try {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = undefined;
      }
      await this.stopListening();
    } catch (err: any) {
      this.logger.debug(
        `Error during destroy(), but that's fine (${err.toString()})}`
      );
    }
  }

  /**
   * Stops listenining for BLE notifications.
   */
  protected async stopListening() {
    if (!this.eventChar) return;

    await this.eventChar.stopNotifications();
    this.eventChar = undefined;
  }
}

/**
 * Waits for the renpho scale to be turned on and calls onConnect() afterwards.
 * You will want to subscribe to events of the scale argument the function will be called with.
 * @param mac A MAC address for the Bluetooth Low Energy device.
 * @param opts.onConnect Callback that will be invoked with a RenphoScale instance.
 * @param levelevel `tslog` log level. To get everything use `trace`
 * @param opts.once If true, the loop exits after the first iteration.
 */
export const runMessageLoop = async (
  mac: string,
  opts: {
    onConnect?: (scale: RenphoScale) => unknown;
    once?: boolean;
    loglevel?: TLogLevelName;
  } = {}
) => {
  const logger = getLogger("runMessageLoop()");

  const { bluetooth, destroy: destroyBluetooth } = createBluetooth();
  let destroyScaleSession: ((...args: any[]) => unknown) | undefined =
    undefined;

  try {
    const adapter = await bluetooth.defaultAdapter();

    const connectAndHandle = async () => {
      const scale = await RenphoScale.connect(adapter, mac, opts);
      let raiseFlag: () => unknown;
      scale
        .on("timeout", () => {
          if (raiseFlag) raiseFlag();
        })
        .on("measurement", () => {
          if (raiseFlag) raiseFlag();
        });

      opts.onConnect?.(scale);

      await scale.startListening(10);

      // this resolves as soon as raiseFlag() is called
      await new Promise<void>((resolve) => {
        raiseFlag = resolve;
      });

      // destructor to be called from somewhere else
      return () => {
        scale.destroy();
      };
    };

    // TODO DBusError: Operation already in progress can spam the console
    while (true) {
      try {
        destroyScaleSession = await connectAndHandle();
        if (opts.once) break;
      } catch (err: any) {
        logger.warn(err.toString());
      }
      logger.debug("Next iteration!");
      await delay(1);
    }

    // <-- if we get to here, `once` is set and we're done
  } finally {
    logger.info("Destroying bluetooth connection");
    if (destroyScaleSession) destroyScaleSession();
    destroyBluetooth();
  }
};
