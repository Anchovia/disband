// Core note segmentation logic.

#include "internal.h"
#include "../judgment_errors/errors.h"

#include <algorithm>
#include <cstddef>
#include <cmath>
#include <limits>

namespace disband::session::note_extraction
{
namespace
{
constexpr double kMinimumPitchWeight = 0.05;
constexpr double kPitchSplitMidiDelta = 1.2;
constexpr int kPitchSplitFrames = 2;
constexpr double kMinSplitIntervalMs = 25.0;
constexpr int kLowEnergyEndFrames = 2;
constexpr double kStableSegmentDurationRatio = 2.0;
constexpr double kMinPitchBridgeProgress = 0.15;
constexpr double kMaxPitchBridgeProgress = 0.9;

std::vector<double> normalizeCycle(std::vector<double> cycle)
{
    if (cycle.empty())
        return cycle;

    double mean = 0.0;
    for (double value : cycle)
        mean += value;
    mean /= static_cast<double>(cycle.size());

    double sumSquares = 0.0;
    for (double value : cycle)
    {
        const double centered = value - mean;
        sumSquares += centered * centered;
    }

    const double rms = std::sqrt(sumSquares / static_cast<double>(std::max<size_t>(1, cycle.size())));
    if (rms <= std::numeric_limits<double>::epsilon())
    {
        std::fill(cycle.begin(), cycle.end(), 0.0);
        return cycle;
    }

    for (double& value : cycle)
        value = (value - mean) / rms;

    return cycle;
}

std::vector<double> computeWaveformProfile(
    const juce::AudioBuffer<float>& workingBuffer,
    int startSample,
    int sampleCount,
    double sampleRate,
    double frequencyHz,
    int cycleCount)
{
    if (workingBuffer.getNumChannels() <= 0 || workingBuffer.getNumSamples() <= 0)
        return {};
    if (startSample < 0 || sampleCount <= 0 || sampleRate <= 0.0 || frequencyHz <= 0.0 || cycleCount <= 0)
        return {};

    const int periodSamples = std::max(1, static_cast<int>(std::lround(sampleRate / frequencyHz)));
    const int endSample = std::min(startSample + sampleCount, workingBuffer.getNumSamples());
    const int availableSamples = endSample - startSample;
    const int availableCycles = availableSamples / periodSamples;
    const int cyclesToUse = std::min(cycleCount, availableCycles);
    if (cyclesToUse <= 0)
        return {};

    const float* samples = workingBuffer.getReadPointer(0);
    std::vector<double> profile(static_cast<size_t>(periodSamples), 0.0);
    for (int cycle = 0; cycle < cyclesToUse; ++cycle)
    {
        const int cycleStart = startSample + (cycle * periodSamples);
        std::vector<double> cycleProfile(static_cast<size_t>(periodSamples), 0.0);
        for (int i = 0; i < periodSamples; ++i)
            cycleProfile[static_cast<size_t>(i)] = static_cast<double>(samples[cycleStart + i]);

        cycleProfile = normalizeCycle(std::move(cycleProfile));
        for (int i = 0; i < periodSamples; ++i)
            profile[static_cast<size_t>(i)] += cycleProfile[static_cast<size_t>(i)];
    }

    for (double& value : profile)
        value /= static_cast<double>(cyclesToUse);

    return profile;
}

void mergeShortPitchBridges(
    std::vector<PlayedNote>& notes,
    const juce::AudioBuffer<float>& workingBuffer,
    double sampleRate,
    int hopSize,
    uint_t analysisBufferSize,
    const DetectionSettings& settings)
{
    if (notes.size() < 3 || sampleRate <= 0.0 || analysisBufferSize == 0)
        return;

    const double analysisWindowMs =
        static_cast<double>(analysisBufferSize) * 1000.0 / sampleRate;
    const double contiguousToleranceMs =
        static_cast<double>(hopSize) * 1000.0 / sampleRate;

    for (size_t index = 1; index + 1 < notes.size();)
    {
        const auto& previous = notes[index - 1];
        const auto& fragment = notes[index];
        const auto& stable = notes[index + 1];
        const double fragmentDurationMs = fragment.endMs - fragment.startMs;
        const double stableDurationMs = stable.endMs - stable.startMs;
        const bool hasBridgePitches =
            previous.frequencyHz > 0.0
            && fragment.frequencyHz > 0.0
            && stable.frequencyHz > 0.0;
        const double previousPitch =
            hasBridgePitches ? frequencyToMidi(previous.frequencyHz) : 0.0;
        const double fragmentPitch =
            hasBridgePitches ? frequencyToMidi(fragment.frequencyHz) : 0.0;
        const double stablePitch =
            hasBridgePitches ? frequencyToMidi(stable.frequencyHz) : 0.0;
        const double transitionPitchDelta = stablePitch - previousPitch;
        const double pitchBridgeProgress = std::abs(transitionPitchDelta) > 0.0
            ? (fragmentPitch - previousPitch) / transitionPitchDelta
            : 0.0;
        const int stableMidiStep = std::abs(stable.midi - previous.midi);
        const bool isPitchBridge =
            hasBridgePitches
            && stableMidiStep >= 1
            && stableMidiStep <= 2
            && pitchBridgeProgress >= kMinPitchBridgeProgress
            && pitchBridgeProgress <= kMaxPitchBridgeProgress;
        const bool isContiguous =
            std::abs(fragment.startMs - previous.endMs) <= contiguousToleranceMs
            && std::abs(stable.startMs - fragment.endMs) <= contiguousToleranceMs;
        const bool isShortThenStable =
            fragmentDurationMs > 0.0
            && fragmentDurationMs < analysisWindowMs
            && stableDurationMs >= fragmentDurationMs * kStableSegmentDurationRatio;

        if (!isPitchBridge || !isContiguous || !isShortThenStable)
        {
            ++index;
            continue;
        }

        const double combinedDurationMs = fragmentDurationMs + stableDurationMs;
        const double mergedFrequencyHz =
            ((fragment.frequencyHz * fragmentDurationMs)
                + (stable.frequencyHz * stableDurationMs))
            / combinedDurationMs;
        const int mergedMidi = mergedFrequencyHz > 0.0
            ? static_cast<int>(std::lround(frequencyToMidi(mergedFrequencyHz)))
            : -1;
        if (mergedMidi != stable.midi)
        {
            ++index;
            continue;
        }

        PlayedNote merged = fragment;
        merged.endMs = stable.endMs;
        merged.frequencyHz = mergedFrequencyHz;
        merged.midi = mergedMidi;
        merged.confidence =
            ((fragment.confidence * fragmentDurationMs)
                + (stable.confidence * stableDurationMs))
            / combinedDurationMs;

        const int startSample = std::max(
            0,
            static_cast<int>(std::lround(merged.startMs * sampleRate / 1000.0)));
        const int mergedSamples = std::max(
            1,
            static_cast<int>(std::lround(combinedDurationMs * sampleRate / 1000.0)));
        const int velocityWindowSamples = std::max(
            1,
            static_cast<int>(std::lround(
                settings.velocityAnalysisWindowMs * sampleRate / 1000.0)));
        merged.waveformProfile = computeWaveformProfile(
            workingBuffer,
            startSample,
            std::min(mergedSamples, velocityWindowSamples),
            sampleRate,
            merged.frequencyHz,
            settings.waveformProfileCycleCount);

        notes[index] = std::move(merged);
        notes.erase(notes.begin() + static_cast<std::ptrdiff_t>(index + 1));
        ++index;
    }
}
} // namespace

std::vector<PlayedNote> detectNotes(
    const juce::AudioBuffer<float>& workingBuffer,
    int hopSize,
    double sampleRate,
    const DetectionSettings& settings,
    AubioContext& context)
{
    std::vector<PlayedNote> notes;

    const float* samples = workingBuffer.getReadPointer(0);
    const int maxStart = workingBuffer.getNumSamples() - hopSize;
    const int onsetCompensationSamples = std::max(
        0,
        static_cast<int>(std::lround(settings.onsetCompensationMs * sampleRate / 1000.0)));

    bool inNote = false;
    bool suppressDelayedOnset = false;
    int noteStartSample = 0;
    int lowEnergyFrames = 0;
    int pitchSplitFrames = 0;
    int framesSinceLastSplit = std::numeric_limits<int>::max();
    double previousLevelDb = settings.silenceDb;
    double weightedHz = 0.0;
    double totalWeight = 0.0;
    double confidenceSum = 0.0;
    int confidentFrames = 0;

    auto startNoteAt = [&](
        int startSample,
        bool shouldSuppressDelayedOnset,
        double currentLevelDb,
        bool currentHasPitch,
        double currentHz,
        double currentConfidence)
    {
        inNote = true;
        suppressDelayedOnset = shouldSuppressDelayedOnset;
        noteStartSample = startSample;
        lowEnergyFrames = 0;
        pitchSplitFrames = 0;
        framesSinceLastSplit = 0;
        previousLevelDb = currentLevelDb;
        
        if (currentHasPitch)
        {
            const auto weight = std::max(currentConfidence, kMinimumPitchWeight);
            weightedHz = currentHz * weight;
            totalWeight = weight;
            confidenceSum = currentConfidence;
            confidentFrames = 1;
        }
        else
        {
            weightedHz = 0.0;
            totalWeight = 0.0;
            confidenceSum = 0.0;
            confidentFrames = 0;
        }
    };

    auto flushCurrentNote = [&](int noteEndSample) {
        if (!inNote)
            return;

        const auto startMs = static_cast<double>(noteStartSample) * 1000.0 / sampleRate;
        const auto endMs = static_cast<double>(noteEndSample) * 1000.0 / sampleRate;
        const auto durationMs = endMs - startMs;

        if (durationMs >= settings.minNoteMs)
        {
            const int noteSamples = std::max(1, noteEndSample - noteStartSample);
            const int velocityWindowSamples = std::max(
                1,
                static_cast<int>(std::lround(settings.velocityAnalysisWindowMs * sampleRate / 1000.0)));
            const int velocitySampleCount = std::min(noteSamples, velocityWindowSamples);
            const auto windowAnalysis =
                computeNoteWindowFeatures(workingBuffer, noteStartSample, velocitySampleCount);
            const auto hz = totalWeight > 0.0 ? (weightedHz / totalWeight) : 0.0;
            const int midiRounded = hz > 0.0
                ? static_cast<int>(std::lround(frequencyToMidi(hz)))
                : -1;
            const auto waveformProfile = computeWaveformProfile(
                workingBuffer,
                noteStartSample,
                velocitySampleCount,
                sampleRate,
                hz,
                settings.waveformProfileCycleCount);

            notes.push_back({
                startMs,
                endMs,
                hz,
                midiRounded,
                confidenceSum / static_cast<double>(std::max(1, confidentFrames)),
                windowAnalysis.velocityRms,
                std::move(waveformProfile)
            });
        }

        inNote = false;
        suppressDelayedOnset = false;
        noteStartSample = 0;
        lowEnergyFrames = 0;
        pitchSplitFrames = 0;
        framesSinceLastSplit = std::numeric_limits<int>::max();
        previousLevelDb = settings.silenceDb;
        weightedHz = 0.0;
        totalWeight = 0.0;
        confidenceSum = 0.0;
        confidentFrames = 0;
    };

    for (int frameStart = 0; frameStart <= maxStart; frameStart += hopSize)
    {
        for (int i = 0; i < hopSize; ++i)
        {
            const int sampleIndex = frameStart + i;
            const float value = sampleIndex < workingBuffer.getNumSamples()
                ? samples[sampleIndex]
                : 0.0f;
            fvec_set_sample(context.pitchInput, static_cast<smpl_t>(value), static_cast<uint_t>(i));
        }

        aubio_onset_do(context.onset, context.pitchInput, context.onsetOutput);
        const auto levelDb = static_cast<double>(aubio_db_spl(context.pitchInput));
        const bool pitchInputSilent = levelDb < settings.silenceDb;
        if (pitchInputSilent)
        {
            advanceAubioPitchBuffer(context, context.pitchInput);
            fvec_set_sample(context.pitchOutput, 0.0f, 0);
        }
        else
        {
            aubio_pitch_do(context.pitch, context.pitchInput, context.pitchOutput);
        }

        const bool onsetDetected = fvec_get_sample(context.onsetOutput, 0) > 0.0f;
        const bool isSilent = !std::isfinite(levelDb) || levelDb <= settings.silenceDb;
        const auto hz = static_cast<double>(fvec_get_sample(context.pitchOutput, 0));
        const auto confidenceRaw = pitchInputSilent
            ? 0.0
            : static_cast<double>(aubio_pitch_get_confidence(context.pitch));
        const auto confidence = std::isfinite(confidenceRaw)
            ? std::clamp(confidenceRaw, 0.0, 1.0)
            : 0.0;
        const bool hasPitch = std::isfinite(hz)
            && hz >= settings.pitchMinHz
            && hz <= settings.pitchMaxHz;

        if (!inNote)
        {
            if (onsetDetected || !isSilent)
            {
                const int detectedSample = static_cast<int>(aubio_onset_get_last(context.onset));
                const int startSample = (onsetDetected && detectedSample >= 0 && detectedSample <= frameStart + hopSize)
                    ? std::max(0, detectedSample - onsetCompensationSamples)
                    : frameStart;
                startNoteAt(startSample, !onsetDetected, levelDb, hasPitch, hz, confidence);
            }
            continue;
        }

        if (isSilent)
        {
            ++lowEnergyFrames;
            ++framesSinceLastSplit;
        }
        else
        {
            lowEnergyFrames = 0;
            ++framesSinceLastSplit;
            if (hasPitch && confidence >= settings.minPitchConfidence && totalWeight > 0.0)
            {
                const auto noteHz = weightedHz / totalWeight;
                const auto midiDelta = std::abs(frequencyToMidi(hz) - frequencyToMidi(noteHz));
                if (midiDelta >= kPitchSplitMidiDelta)
                    ++pitchSplitFrames;
                else
                    pitchSplitFrames = 0;
            }
            else
            {
                pitchSplitFrames = 0;
            }

            const int minSplitFrames = std::max(1, static_cast<int>(std::round(kMinSplitIntervalMs / settings.hopSizeMs)));
            const bool canSplitNow = framesSinceLastSplit >= minSplitFrames;
            const bool pitchTransitionDetected = pitchSplitFrames >= kPitchSplitFrames;
            const int detectedSample = static_cast<int>(aubio_onset_get_last(context.onset));
            const int onsetSplitSample = (onsetDetected && detectedSample >= 0 && detectedSample <= frameStart + hopSize)
                ? std::max(0, detectedSample - onsetCompensationSamples)
                : frameStart;
            // The energy gate starts a note immediately, while onset and pitch need
            // one full analysis window to settle. Suppress only the delayed onset
            // belonging to an energy- or pitch-started note; onset-started notes can
            // accept the next onset immediately, which preserves dense repetitions.
            const bool onsetCanSplit = onsetDetected
                && (!suppressDelayedOnset
                    || onsetSplitSample - noteStartSample >= static_cast<int>(context.onsetBufferSize));
            if (canSplitNow && (onsetCanSplit || pitchTransitionDetected))
            {
                // Split on explicit onsets; use a short, high-threshold pitch jump fallback.
                const int splitSample = onsetCanSplit ? onsetSplitSample : frameStart;
                const bool startedFromPitchTransition = !onsetCanSplit && pitchTransitionDetected;
                flushCurrentNote(splitSample);
                startNoteAt(
                    splitSample,
                    startedFromPitchTransition,
                    levelDb,
                    hasPitch,
                    hz,
                    confidence);
                continue;
            }
            if (hasPitch)
            {
                const auto weight = std::max(confidence, kMinimumPitchWeight);
                weightedHz += hz * weight;
                totalWeight += weight;
                confidenceSum += confidence;
                ++confidentFrames;
            }
            previousLevelDb = levelDb;
        }

        if (lowEnergyFrames >= kLowEnergyEndFrames)
            flushCurrentNote(frameStart);
    }

    flushCurrentNote(workingBuffer.getNumSamples() - 1);
    mergeShortPitchBridges(
        notes,
        workingBuffer,
        sampleRate,
        hopSize,
        context.pitchBufferSize,
        settings);

    return notes;
}
} // namespace disband::session::note_extraction
