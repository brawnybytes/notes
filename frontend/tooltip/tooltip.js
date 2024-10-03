

document.addEventListener('DOMContentLoaded', function () {
    const triggers = document.querySelectorAll('.tooltip');

    function createTooltipElement(text) {
        const tooltip = document.createElement('div');
        // tooltip.classList.add('tooltip', 'tooltip-bottom');
        tooltip.innerText = text;
        document.body.appendChild(tooltip);
        return tooltip;
    }

    triggers.forEach(trigger => {
        let tooltipEle = null;

        trigger.addEventListener('mouseenter', () => {
            const tooltipText = trigger.getAttribute('data-tooltip');
            tooltipEle = createTooltipElement(tooltipText);
            tooltipEle.style.visibility = 'visible';
        })

        trigger.addEventListener('mouseleave', () => {
            if (tooltipEle) {
                tooltipEle.style.visibility = 'hidden';
                tooltipEle.remove();
                tooltipEle = null;
            }
        })
    })
})