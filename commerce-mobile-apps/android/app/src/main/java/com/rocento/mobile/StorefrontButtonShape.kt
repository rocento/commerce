package com.rocento.mobile

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

// Filled and outlined Material buttons otherwise use a capsule, ignoring brand corners.
val LocalStorefrontButtonShape = staticCompositionLocalOf<Shape> { RoundedCornerShape(18.dp) }
