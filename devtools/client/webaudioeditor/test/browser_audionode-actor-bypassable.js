/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Test AudioNode#bypassable
 */

add_task(async function () {
  let { target, front } = await initBackend(SIMPLE_NODES_URL);
  let [_, nodes] = await Promise.all([
    front.setup({ reload: true }),
    getN(front, "create-node", 14)
  ]);

  let actualBypassability = nodes.map(node => node.bypassable);
  let expectedBypassability = [
    false, // AudioDestinationNode
    true, // AudioBufferSourceNode
    true, // ScriptProcessorNode
    true, // AnalyserNode
    true, // GainNode
    true, // DelayNode
    true, // BiquadFilterNode
    true, // WaveShaperNode
    true, // PannerNode
    true, // ConvolverNode
    false, // ChannelSplitterNode
    false, // ChannelMergerNode
    true, // DynamicsCompressNode
    true, // OscillatorNode
  ];

  expectedBypassability.forEach((bypassable, i) => {
    is(actualBypassability[i], bypassable, `${nodes[i].type} has correct ".bypassable" status`);
  });

  await removeTab(target.tab);
});
