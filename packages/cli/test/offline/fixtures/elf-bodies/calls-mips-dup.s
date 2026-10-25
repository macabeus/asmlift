	.set	noreorder
	.text
	.type	dup, @function
dup:
	jr	$ra
	li	$v0, 9
	.size	dup, .-dup
