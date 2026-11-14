def average(items):
	"""Mean of a list of numbers."""
	total = 0
	for value in items:
		total += value
	return total / len(items)


def spread(items):
	return max(items) - min(items)
