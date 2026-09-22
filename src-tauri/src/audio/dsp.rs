use std::collections::VecDeque;

pub(crate) fn pcm_f32le_to_samples(chunk: &[u8]) -> Vec<f32> {
    chunk
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .collect()
}

pub(crate) fn append_f32_samples_from_bytes(queue: &mut VecDeque<f32>, chunk: &[u8]) {
    queue.extend(pcm_f32le_to_samples(chunk));
}

pub(crate) fn samples_to_pcm_f32le(samples: &[f32]) -> Vec<u8> {
    let mut output = Vec::with_capacity(samples.len() * std::mem::size_of::<f32>());
    for sample in samples {
        output.extend_from_slice(&sample.to_le_bytes());
    }
    output
}

/// Soft-knee limiter used after RNNoise and microphone gain.
#[inline]
pub(crate) fn soft_limit(sample: f32) -> f32 {
    const KNEE_START: f32 = 0.68;
    const CEILING: f32 = 0.96;

    if !sample.is_finite() {
        return 0.0;
    }

    let abs_sample = sample.abs();
    if abs_sample <= KNEE_START {
        return sample;
    }

    let knee_width = CEILING - KNEE_START;
    let over = ((abs_sample - KNEE_START) / knee_width).max(0.0);
    let compressed = KNEE_START + knee_width * (1.0 - (-over).exp());
    sample.signum() * compressed.min(CEILING)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_round_trip_preserves_samples_and_ignores_partial_tail() {
        let source = [-1.0, -0.25, 0.0, 0.5, 1.0];
        let mut bytes = samples_to_pcm_f32le(&source);
        bytes.extend_from_slice(&[0xaa, 0xbb]);
        assert_eq!(pcm_f32le_to_samples(&bytes), source);
    }

    #[test]
    fn limiter_is_finite_symmetric_and_bounded() {
        assert_eq!(soft_limit(f32::NAN), 0.0);
        assert_eq!(soft_limit(0.5), 0.5);
        assert_eq!(soft_limit(-2.0), -soft_limit(2.0));
        assert!(soft_limit(100.0) <= 0.96);
    }

    #[test]
    fn empty_and_partial_buffers_do_not_create_samples() {
        assert!(pcm_f32le_to_samples(&[]).is_empty());
        assert!(pcm_f32le_to_samples(&[1, 2, 3]).is_empty());
    }
}
