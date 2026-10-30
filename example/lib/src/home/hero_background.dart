import 'dart:ui' as ui;

import 'package:flutter/material.dart';

/// The hero's backdrop: a fragment shader, animated.
///
/// A shader is an asset too, so it arrives through the worker like any other
/// file. Until it does, or if the renderer cannot run it, the gradient
/// underneath stands in.
class HeroBackground extends StatefulWidget {
  /// Creates the backdrop.
  const HeroBackground({super.key});

  @override
  State<HeroBackground> createState() => _HeroBackgroundState();
}

class _HeroBackgroundState extends State<HeroBackground>
    with SingleTickerProviderStateMixin {
  late final AnimationController _clock = AnimationController(
    vsync: this,
    duration: const Duration(minutes: 10),
  );
  ui.FragmentShader? _shimmer;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final shimmer = await ui.FragmentProgram.fromAsset('assets/shaders/shimmer.frag');
      if (!mounted) return;
      setState(() => _shimmer = shimmer.fragmentShader());
    } on Object {
      // The gradient stays.
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _clock.stop();
    } else if (!_clock.isAnimating) {
      _clock.repeat();
    }
  }

  @override
  void dispose() {
    _clock.dispose();
    _shimmer?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: const BoxDecoration(
      gradient: LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color(0xFF06281F), Color(0xFF0E5A43)],
      ),
    ),
    child: _shimmer == null
        ? const SizedBox.expand()
        : CustomPaint(
            size: Size.infinite,
            painter: _ShaderPainter(_shimmer!, _clock),
          ),
  );
}

class _ShaderPainter extends CustomPainter {
  _ShaderPainter(this.shimmer, this.clock) : super(repaint: clock);

  final ui.FragmentShader shimmer;
  final Animation<double> clock;

  @override
  void paint(Canvas canvas, Size size) {
    final seconds = clock.value * 600;
    shimmer
      ..setFloat(0, size.width)
      ..setFloat(1, size.height)
      ..setFloat(2, seconds * 0.4)
      ..setColor(3, const Color(0xFF0F6B4F))
      ..setColor(7, const Color(0xFF06281F))
      ..setFloat(11, 4);
    final area = Offset.zero & size;
    canvas.drawRect(area, Paint()..shader = shimmer);
  }

  @override
  bool shouldRepaint(_ShaderPainter oldDelegate) =>
      oldDelegate.shimmer != shimmer;
}

extension on ui.FragmentShader {
  /// Sets a `vec4` color uniform starting at [index].
  void setColor(int index, Color color) {
    setFloat(index, color.r);
    setFloat(index + 1, color.g);
    setFloat(index + 2, color.b);
    setFloat(index + 3, color.a);
  }
}
