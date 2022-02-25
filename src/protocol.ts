import { buf2hex, lpad } from "./util";

export interface BasePacket {
  packetId: number
  len: number
  checksum: number
  data: Buffer

  toString(): string
}

export type FirstPacket = BasePacket & {
  packetId: 0x12

}
export type SecondPacket = BasePacket & {
  packetId: 0x14
}

export type WeightDataPacket = BasePacket & {
  packetId: 0x10
  scaleType: number
  weight: number
}


export type Packet = FirstPacket | SecondPacket | WeightDataPacket


export const packet2str = (packet: Packet): string => {
  const formatValue = (key: string, val: any) => {
    switch (key) {
      case 'packetId':
      case 'scaleType':
        return lpad(val, 2)
      case 'weight':
        return lpad(val.toFixed(2), 3 + 1 + 2)
      case 'checksum':
        return lpad(val, 4)
      case 'data':
        return buf2hex(val)
      default:
        return val
    }
  }

  const kvs = Object.entries(packet).filter(([k]) => k !== 'data').map(([k, v]) => `${k}=${formatValue(k, v)}`)
  // data property last
  kvs.push(`data=${formatValue("data", packet.data)}`)
  return kvs.join(' ')
}

export const parseIncomingPacket = (buf: Buffer): Packet => {
  const packetId = buf[0] as Packet['packetId']
  const len = buf[1]
  const checksum = buf[buf.length - 1]
  const packet: Packet = { packetId, len, checksum, data: buf } as Packet
  switch (packet.packetId) {
    case 0x12:
      return packet
    case 0x14:
      return packet
    case 0x10:
      packet.scaleType = buf[2]
      packet.weight = ((buf[3] << 8) + buf[4]) / 100
      return packet
    default:
      return packet
  }
}