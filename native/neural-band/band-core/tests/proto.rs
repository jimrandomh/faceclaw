use band_core::datax::{DataXReceiver, encode_frame};
use band_core::proto::{ProtoFields, field_bytes, field_int, varint};

#[test]
fn builders_produce_protobuf_wire_format() {
    assert_eq!(varint(0), vec![0]);
    assert_eq!(varint(300), vec![0xac, 0x02]);
    assert_eq!(field_int(1, 1), vec![0x08, 0x01]);
    assert_eq!(field_bytes(5, &[]), vec![0x2a, 0x00]);
    assert_eq!(field_int(10, 1), vec![0x50, 0x01]);
    let long = vec![b'x'; 1777];
    assert_eq!(&field_bytes(2, &long)[..3], &[0x12, 0xf1, 0x0d]);
}

#[test]
fn parser_reads_integers_bytes_and_skips_fixed_fields() {
    let data = [
        field_int(1, 42),
        field_bytes(3, b"abc"),
        vec![0x21, 1, 2, 3, 4, 5, 6, 7, 8], // field 4, wire type 1 (fixed64)
        vec![0x2d, 1, 2, 3, 4],             // field 5, wire type 5 (fixed32)
    ]
    .concat();
    let fields = ProtoFields::parse(&data).unwrap();
    assert_eq!(fields.integer(1).unwrap(), 42);
    assert_eq!(fields.required_integer(1).unwrap(), 42);
    assert_eq!(
        fields.integer(2).unwrap(),
        0,
        "absent integers default to 0"
    );
    assert!(fields.required_integer(2).is_err());
    assert_eq!(fields.bytes(3).unwrap(), b"abc");
    assert!(fields.bytes_len(3, 4).is_err());
    assert!(fields.contains(4) && fields.contains(5));
    assert!(fields.integer(4).is_err(), "fixed fields are not integers");
    assert!(fields.bytes(2).is_err());
}

#[test]
fn parser_rejects_malformed_input() {
    assert!(
        ProtoFields::parse(&[0x08, 0x80]).is_err(),
        "truncated varint"
    );
    assert!(
        ProtoFields::parse(&[0x08, 1, 0x08, 2])
            .unwrap()
            .required_integer(1)
            .is_err(),
        "repeated integer"
    );
    assert!(
        ProtoFields::parse(&[0x1a, 12, 1]).is_err(),
        "truncated bytes"
    );
    assert!(ProtoFields::parse(&[0x00]).is_err(), "field number 0");
    assert!(ProtoFields::parse(&[0x0b]).is_err(), "wire type 3");
    let overflow = [
        0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02,
    ];
    assert!(ProtoFields::parse(&overflow).is_err(), "varint overflow");
}

#[test]
fn frames_carry_a_typed_header_only_when_words_are_present() {
    let typed = encode_frame(0x8001, &[0x81000005, 0x02000001], &[0xaa]).unwrap();
    assert_eq!(hex::encode(&typed), "800980018100000502000001aa");
    let plain = encode_frame(5, &[], &[1, 2]).unwrap();
    assert_eq!(plain, vec![0x00, 0x02, 0x00, 0x05, 1, 2]);
    assert!(encode_frame(1, &[], &vec![0; 0x8000]).is_err());
}

#[test]
fn native_framing_preserves_split_messages_and_rejects_malformed_input() {
    let mut receiver = DataXReceiver::default();
    let payload: Vec<u8> = (0..40).collect();
    let frame = encode_frame(0x8005, &[0x0200020d], &payload).unwrap();
    let head = [&frame[..13], &[0xc3; 3][..]].concat();
    assert!(receiver.feed(&head).unwrap().is_empty());
    let tail = [&frame[13..], &[0xcd; 13][..]].concat();
    let frames = receiver.feed(&tail).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].channel, 0x8005);
    assert_eq!(frames[0].words, vec![0x0200020d]);
    assert_eq!(frames[0].payload, payload);
    assert!(
        DataXReceiver::default().feed(&[0; 15]).is_err(),
        "unaligned plaintext"
    );
    // A typed header whose words run past the frame end.
    let bad = [vec![0x80, 0x04, 0x00, 0x01, 0x80, 0, 0, 0], vec![0xc8; 8]].concat();
    assert!(DataXReceiver::default().feed(&bad).is_err());
}

/// An aligned frame (length % 16 == 0) is sent without padding, so a final
/// payload byte that merely looks like padding (0xc1, or 0xc2 0xc2) is data.
#[test]
fn an_aligned_frame_ending_in_a_padding_like_byte_is_not_stripped() {
    for tail in [&[0xc1][..], &[0xc2, 0xc2][..]] {
        // 4-byte header + 4-byte word + 24-byte payload = 32 bytes.
        let mut payload: Vec<u8> = (0..24).collect();
        let at = payload.len() - tail.len();
        payload[at..].copy_from_slice(tail);
        let frame = encode_frame(5, &[0x0200020d], &payload).unwrap();
        assert_eq!(frame.len() % 16, 0);
        let frames = DataXReceiver::default().feed(&frame).unwrap();
        assert_eq!(frames.len(), 1, "tail {tail:02x?}");
        assert_eq!(frames[0].channel, 5);
        assert_eq!(frames[0].words, vec![0x0200020d]);
        assert_eq!(frames[0].payload, payload, "tail {tail:02x?}");
    }
}

#[test]
fn a_padded_record_still_loses_its_padding() {
    for payload_len in 1..=16usize {
        let payload: Vec<u8> = (0..payload_len as u8).map(|b| b ^ 0xc1).collect();
        let frame = encode_frame(5, &[0x0200020d], &payload).unwrap();
        let count = (16 - frame.len() % 16) % 16;
        let record = [frame.clone(), vec![0xc0 + count as u8; count]].concat();
        let frames = DataXReceiver::default().feed(&record).unwrap();
        assert_eq!(frames.len(), 1, "payload length {payload_len}");
        assert_eq!(frames[0].payload, payload, "payload length {payload_len}");
    }
}

#[test]
fn an_aligned_record_ending_in_0xc1_does_not_corrupt_the_next_record() {
    let mut receiver = DataXReceiver::default();
    let mut first: Vec<u8> = (0..24).collect();
    *first.last_mut().unwrap() = 0xc1;
    let aligned = encode_frame(5, &[0x0200020d], &first).unwrap();
    assert_eq!(aligned.len(), 32);
    let frames = receiver.feed(&aligned).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload, first);

    let second: Vec<u8> = (100..110).collect();
    let frame = encode_frame(0x8010, &[0x02000315], &second).unwrap();
    let count = (16 - frame.len() % 16) % 16;
    let record = [frame, vec![0xc0 + count as u8; count]].concat();
    let frames = receiver.feed(&record).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].channel, 0x8010);
    assert_eq!(frames[0].words, vec![0x02000315]);
    assert_eq!(frames[0].payload, second);
}

/// Newer firmware pads a block-aligned frame with a whole block of 0xd0 (seen
/// on hardware: a 1888-byte identity reply in a 1904-byte record); the block
/// must go, or the next record's frame is parsed from the padding.
#[test]
fn a_whole_block_of_padding_after_an_aligned_frame_is_dropped() {
    let mut receiver = DataXReceiver::default();
    let first: Vec<u8> = (0..24).collect();
    let aligned = encode_frame(2, &[0x02003001], &first).unwrap();
    assert_eq!(aligned.len(), 32);
    let record = [aligned, vec![0xd0; 16]].concat();
    let frames = receiver.feed(&record).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload, first);
    assert_eq!(receiver.pending_len(), 0);

    let second: Vec<u8> = (0..18).collect();
    let frame = encode_frame(2, &[0x02002001], &second).unwrap();
    assert_eq!(frame.len(), 26);
    let frames = receiver.feed(&[frame, vec![0xc6; 6]].concat()).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].words, vec![0x02002001]);
    assert_eq!(frames[0].payload, second);
}

/// Newer firmware also splits a frame across records and pads the first part (seen on hardware
/// 2026-10-13: a gesture-stream frame completed with 0xd0 padding, after which every frame was
/// misread and gestures stopped reaching the app). Once a whole block of 0xd0 shows the firmware
/// pads every record, each record's padding goes before the frame is reassembled.
#[test]
fn a_frame_split_across_padded_records_is_reassembled() {
    let mut receiver = DataXReceiver::default();
    let first: Vec<u8> = (0..24).collect();
    let aligned = encode_frame(2, &[0x02003001], &first).unwrap();
    assert_eq!(receiver.feed(&[aligned, vec![0xd0; 16]].concat()).unwrap().len(), 1);

    let payload: Vec<u8> = (0..40).collect();
    let frame = encode_frame(5, &[0x0200020f], &payload).unwrap();
    assert_eq!(frame.len(), 48);
    // 16 bytes of the frame, padded by a whole block; then the remaining 32, padded too.
    let head = [frame[..16].to_vec(), vec![0xd0; 16]].concat();
    assert!(receiver.feed(&head).unwrap().is_empty());
    let frames = receiver.feed(&[frame[16..].to_vec(), vec![0xd0; 16]].concat()).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].words, vec![0x0200020f]);
    assert_eq!(frames[0].payload, payload);
    assert_eq!(receiver.pending_len(), 0);
}
