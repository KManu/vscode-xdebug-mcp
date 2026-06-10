FROM php:8.2-cli

RUN pecl install xdebug-3.4.2 \
    && docker-php-ext-enable xdebug \
    && rm -rf /tmp/pear

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY trigger.sh /usr/local/bin/trigger.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/trigger.sh

WORKDIR /app
COPY scripts/ /app/scripts/

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["php", "-a"]
