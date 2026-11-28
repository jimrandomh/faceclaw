use band_core::events::{BatteryStatus, EmgBatch, EmgConfig};
use band_core::proto::{field_bytes as fb, field_int as fi};

fn emg_config_reply(id: u64, encoding: u64) -> Vec<u8> {
    let config = [
        fi(1, 2048),
        fi(2, 8),
        fi(4, 16),
        fi(5, 16),
        fi(10, encoding),
    ]
    .concat();
    [fi(1, id), fi(2, 1), fb(6, &fb(42, &config))].concat()
}

fn battery_reply(id: u64, level: u64, charging: Option<u64>) -> Vec<u8> {
    let mut battery = fi(1, level);
    if let Some(charging) = charging {
        battery.extend(fi(2, charging));
    }
    [fi(1, id), fi(2, 1), fb(3, &fb(1, &battery))].concat()
}

#[test]
fn emg_decoder_only_interprets_the_verified_layout() {
    let config = EmgConfig::from_response(&emg_config_reply(7, 0)).unwrap();
    assert!(config.is_supported());
    let samples: Vec<u8> = (0..128u16)
        .flat_map(|i| (32768 + i).to_le_bytes())
        .collect();
    let payload = [fi(1, 100), fi(2, 1_000_000), fb(3, &samples)].concat();
    let batch = EmgBatch::parse(&payload, &config).unwrap();
    assert_eq!((batch.sequence, batch.timestamp_us), (100, 1_000_000));
    assert_eq!(
        &batch.values[..8],
        &(32768..=32775).collect::<Vec<u16>>()[..]
    );
    assert_eq!(batch.values[8], 32776);
    assert_eq!(*batch.values.last().unwrap(), 32895);
    let compressed = EmgConfig::from_response(&emg_config_reply(7, 1)).unwrap();
    assert!(!compressed.is_supported());
    assert!(EmgBatch::parse(&payload, &compressed).is_err());
    assert!(EmgBatch::parse(&payload[..payload.len() - 1], &config).is_err());
    assert!(EmgConfig::from_response(&fi(2, 1)).is_err());
}

#[test]
fn battery_decoder_rejects_invalid_values_and_keeps_an_absent_charging_flag_unknown() {
    assert_eq!(
        BatteryStatus::from_response(&battery_reply(1, 84, Some(1))).unwrap(),
        BatteryStatus {
            level: 84,
            charging: Some(true)
        }
    );
    assert_eq!(
        BatteryStatus::from_response(&battery_reply(1, 84, None))
            .unwrap()
            .charging,
        None
    );
    assert!(BatteryStatus::from_response(&battery_reply(1, 101, Some(1))).is_err());
    assert!(BatteryStatus::from_response(&battery_reply(1, 84, Some(2))).is_err());
    let reply = battery_reply(1, 84, Some(1));
    assert!(BatteryStatus::from_response(&reply[..reply.len() - 1]).is_err());
}

#[test]
fn event_debug_never_prints_raw_emg_bytes() {
    let text = format!("{:?}", band_core::events::Event::RawEmgFrame(vec![0xab; 4]));
    assert!(text.contains("len=4"), "{text}");
    assert!(!text.contains("171"), "{text}");
}
