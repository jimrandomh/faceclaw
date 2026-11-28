//! Minimal protobuf reader/writer (kinesis `BandWire.swift`: `ProtoFields`, `BandWire.field`).

use std::collections::HashMap;

use crate::error::{Result, perr};

#[derive(Debug, Clone)]
enum Value {
    Integer(u64),
    Bytes(Vec<u8>),
    Fixed,
}

/// All fields of one protobuf message, keyed by field number.
#[derive(Clone, Default)]
pub struct ProtoFields {
    values: HashMap<u32, Vec<Value>>,
}

/// Prints only the sorted set of field numbers present; field values may be
/// plaintext and are never included.
impl std::fmt::Debug for ProtoFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut fields: Vec<u32> = self.values.keys().copied().collect();
        fields.sort_unstable();
        f.debug_struct("ProtoFields")
            .field("fields", &fields)
            .finish()
    }
}

fn read_varint(data: &[u8], offset: &mut usize) -> Result<u64> {
    let mut value = 0u64;
    let mut shift = 0u32;
    while shift <= 63 {
        let Some(&byte) = data.get(*offset) else {
            return Err(perr("Truncated protobuf varint"));
        };
        *offset += 1;
        if shift == 63 && byte > 1 {
            return Err(perr("Protobuf varint overflow"));
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
        shift += 7;
    }
    Err(perr("Unterminated protobuf varint"))
}

impl ProtoFields {
    pub fn parse(data: &[u8]) -> Result<Self> {
        let mut values: HashMap<u32, Vec<Value>> = HashMap::new();
        let mut offset = 0usize;
        while offset < data.len() {
            let tag = read_varint(data, &mut offset)?;
            let number = tag >> 3;
            if number == 0 || number >= 1 << 29 {
                return Err(perr("Invalid protobuf field number"));
            }
            let number = number as u32;
            let wire = tag & 7;
            if wire == 0 {
                let integer = read_varint(data, &mut offset)?;
                values
                    .entry(number)
                    .or_default()
                    .push(Value::Integer(integer));
                continue;
            }
            let size = match wire {
                1 => 8,
                2 => read_varint(data, &mut offset)?,
                5 => 4,
                _ => return Err(perr("Unsupported protobuf wire type")),
            };
            if size > (data.len() - offset) as u64 {
                return Err(perr("Truncated protobuf field"));
            }
            let size = size as usize;
            let value = if wire == 2 {
                Value::Bytes(data[offset..offset + size].to_vec())
            } else {
                Value::Fixed
            };
            values.entry(number).or_default().push(value);
            offset += size;
        }
        Ok(Self { values })
    }

    /// The single integer in `field`, or 0 when the field is absent.
    pub fn integer(&self, field: u32) -> Result<u64> {
        match self.values.get(&field) {
            None => Ok(0),
            Some(values) => match values.as_slice() {
                [Value::Integer(integer)] => Ok(*integer),
                _ => Err(perr("Expected protobuf integer")),
            },
        }
    }

    pub fn required_integer(&self, field: u32) -> Result<u64> {
        if !self.values.contains_key(&field) {
            return Err(perr("Missing protobuf integer"));
        }
        self.integer(field)
    }

    /// The single length-delimited value in `field`.
    pub fn bytes(&self, field: u32) -> Result<&[u8]> {
        match self.values.get(&field).map(Vec::as_slice) {
            Some([Value::Bytes(bytes)]) => Ok(bytes),
            _ => Err(perr("Invalid protobuf byte field")),
        }
    }

    /// Like [`bytes`](Self::bytes) but also requires an exact length.
    pub fn bytes_len(&self, field: u32, count: usize) -> Result<&[u8]> {
        let bytes = self.bytes(field)?;
        if bytes.len() != count {
            return Err(perr("Invalid protobuf byte field"));
        }
        Ok(bytes)
    }

    pub fn contains(&self, field: u32) -> bool {
        self.values.contains_key(&field)
    }
}

pub fn varint(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    while value >= 128 {
        bytes.push((value & 127) as u8 | 128);
        value >>= 7;
    }
    bytes.push(value as u8);
    bytes
}

pub fn field_int(number: u32, value: u64) -> Vec<u8> {
    let mut out = varint(u64::from(number) << 3);
    out.extend(varint(value));
    out
}

pub fn field_bytes(number: u32, bytes: &[u8]) -> Vec<u8> {
    let mut out = varint(u64::from(number) << 3 | 2);
    out.extend(varint(bytes.len() as u64));
    out.extend_from_slice(bytes);
    out
}
