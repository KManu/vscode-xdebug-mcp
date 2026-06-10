<?php
/**
 * E2E test script — breakpoint targets for Xdebug integration tests.
 * LINE NUMBERS ARE SIGNIFICANT. Do not reorder without updating tests.
 */

require_once __DIR__ . '/lib.php';

$x = 10;                    // Line 10 — breakpoint for stack + evaluate
$y = 20;                    // Line 11

$result = add($x, $y);     // Line 14 — breakpoint for step_over
$x_plus_y = "x + y = $result\n";
echo $x_plus_y;

$name = "Xdebug";          // Line 18
$greeting = greet($name);  // Line 19 — breakpoint for step test
echo "$greeting\n";

$items = [1, 2, 3];        // Line 22 — breakpoint for variables
$sum = array_sum($items);
echo "sum = $sum\n";

echo "done\n";              // Line 26
